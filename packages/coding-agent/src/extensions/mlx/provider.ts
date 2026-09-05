import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

export const MLX_PROVIDER_ID = "mlx";
export const DEFAULT_MLX_SERVER_URL = "http://127.0.0.1:8080/v1";

/**
 * Normalize a user-entered MLX server URL so it always ends at the OpenAI-compatible
 * `/v1` base. MLX servers (`mlx_lm.server`, `mlx_vlm.server`) expose
 * `/v1/models` and `/v1/chat/completions` at this base.
 */
export function normalizeMlxServerUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	let protocol: string;
	try {
		protocol = new URL(trimmed).protocol;
	} catch {
		throw new Error(`Invalid MLX server URL: ${trimmed || url}`);
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`MLX server URL must use http or https: ${trimmed}`);
	}
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.MLX_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeMlxServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("MLX_BASE_URL"))?.trim();
	return configured ? normalizeMlxServerUrl(configured) : undefined;
}

interface MlxModelEntry {
	id: string;
	object: string;
	created?: number;
}

interface MlxModelsResponse {
	object: string;
	data: MlxModelEntry[];
}

function modelNameFromId(id: string): string {
	// Local absolute path -> basename (e.g. /Users/jake/models/Ornith-9B -> Ornith-9B);
	// HF repo id -> keep as-is (e.g. mlx-community/Qwen3-Coder-30B-4bit).
	if (id.startsWith("/")) {
		const parts = id.split("/").filter((part) => part.length > 0);
		const base = parts[parts.length - 1] || id;
		// Nested variant dirs (e.g. .../Qwen3.8-27B-Uncensored-MLX/4-bit) have a
		// generic leaf name; include the parent so entries stay distinguishable.
		if (parts.length >= 2 && isGenericVariantDirName(base)) {
			return `${parts[parts.length - 2]}/${base}`;
		}
		return base;
	}
	return id;
}

function isGenericVariantDirName(name: string): boolean {
	return /^(?:\d+-bit|\d+bit|bf16|f16|mlx|mtp|text-only(?:-.*)?|vision(?:-.*)?)$/iu.test(name);
}

/**
 * Best-effort context window from a locally-served model's config.json.
 * MLX servers report only id/object/created for `/v1/models`, so we read the
 * model directory directly when the id is an absolute local path.
 */
async function getContextWindowFromLocalConfig(modelId: string): Promise<number | undefined> {
	if (!modelId.startsWith("/")) return undefined;
	try {
		const text = await readFile(join(modelId, "config.json"), "utf8");
		const config = JSON.parse(text) as Record<string, unknown>;
		const direct = config.max_position_embeddings;
		if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
			return Math.floor(direct);
		}
		const textConfig = config.text_config;
		if (typeof textConfig === "object" && textConfig !== null) {
			const nested = (textConfig as Record<string, unknown>).max_position_embeddings;
			if (typeof nested === "number" && Number.isFinite(nested) && nested > 0) {
				return Math.floor(nested);
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Directories scanned for locally-downloaded MLX models. `~/models` is the
 * default; `MLX_MODELS_DIR` (or `MLX_MODEL_DIRS`, delimiter-separated) adds
 * extra roots. The MLX server's `/v1/models` only reports HF-cache entries
 * plus the currently-loaded `--model`, so models kept in `~/models` (e.g.
 * Ornith 35B, Qwen3.8 variants) would otherwise never appear in `/model`.
 */
function mlxLocalModelRoots(): string[] {
	const roots: string[] = [];
	const envValue = process.env.MLX_MODELS_DIR ?? process.env.MLX_MODEL_DIRS ?? process.env.MLX_MODEL_DIR;
	if (typeof envValue === "string" && envValue.trim()) {
		for (const part of envValue.split(delimiter)) {
			const trimmed = part.trim();
			if (trimmed) roots.push(trimmed);
		}
	}
	roots.push(join(homedir(), "models"));
	return [...new Set(roots)];
}

async function isMlxModelDir(dir: string): Promise<boolean> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return false;
	}
	if (!entries.includes("config.json")) return false;
	const hasWeights =
		entries.includes("model.safetensors.index.json") || entries.some((entry) => entry.endsWith(".safetensors"));
	if (!hasWeights) return false;
	// Draft-only dirs (e.g. DFlash2) ship weights without a tokenizer and cannot
	// serve chat completions; require a tokenizer so only usable models surface.
	return entries.includes("tokenizer.json") || entries.includes("tokenizer_config.json");
}

function isSkippedModelDirName(name: string): boolean {
	if (name.startsWith(".")) return true;
	if (name === "assets" || name === ".cache") return true;
	// Multi-token-prediction heads (e.g. `.../mtp`) are draft helpers, not
	// standalone chat models.
	if (name.toLowerCase() === "mtp") return true;
	return name.includes(".partial-") || name.endsWith(".partial") || name.endsWith(".tmp");
}

/**
 * Discover usable local MLX model directories (depth 1, plus one nested level
 * for grouped layouts like `Qwen3.8-27B-Uncensored-MLX/4-bit`). Returns
 * absolute paths suitable as MLX model ids; the server loads them on demand
 * when the id is sent in a chat-completions request.
 */
export async function discoverLocalMlxModels(): Promise<string[]> {
	const found: string[] = [];
	const seen = new Set<string>();
	const add = (path: string): void => {
		if (!seen.has(path)) {
			seen.add(path);
			found.push(path);
		}
	};
	for (const root of mlxLocalModelRoots()) {
		let entries: Dirent[];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (isSkippedModelDirName(entry.name)) continue;
			const full = join(root, entry.name);
			if (await isMlxModelDir(full)) {
				add(full);
				continue;
			}
			let nested: Dirent[];
			try {
				nested = await readdir(full, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const sub of nested) {
				if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
				if (isSkippedModelDirName(sub.name)) continue;
				const subFull = join(full, sub.name);
				if (await isMlxModelDir(subFull)) add(subFull);
			}
		}
	}
	return found;
}

/**
 * Conservative default when the context window cannot be determined (HF repo ids
 * served from cache have no local path, and the `/v1/models` payload carries no size).
 * The MLX server itself enforces its own limits on the request side.
 */
const DEFAULT_CONTEXT_WINDOW = 32768;

// The MLX server's KV cache (--max-kv-size) is shared between the prompt and the
// generation: a request is rejected outright when prompt tokens + max_tokens
// exceed it. Cap the reported context below a typical 65536-token KV cache so
// requests never overflow, and cap generation at the server's --max-tokens
// default (4096). Reading the model's native max_position_embeddings directly is
// not safe here because it can far exceed what the running server actually allows.
const MAX_CONTEXT_WINDOW = 32768;
const MAX_GENERATION_TOKENS = 4096;

function toPiModel(entry: MlxModelEntry, serverUrl: string, contextWindow?: number): Model<"openai-completions"> {
	const cw = Math.min(contextWindow ?? DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
	return {
		id: entry.id,
		name: modelNameFromId(entry.id),
		api: "openai-completions",
		provider: MLX_PROVIDER_ID,
		baseUrl: serverUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: cw,
		maxTokens: MAX_GENERATION_TOKENS,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		},
	};
}

export function createMlxProvider(): { provider: Provider<"openai-completions"> } {
	let models: readonly Model<"openai-completions">[] = [];

	const provider: Provider<"openai-completions"> = {
		id: MLX_PROVIDER_ID,
		name: "MLX",
		baseUrl: DEFAULT_MLX_SERVER_URL,
		auth: {
			apiKey: {
				name: "MLX server",
				login: async (interaction) => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "MLX server URL",
						placeholder: process.env.MLX_BASE_URL ?? DEFAULT_MLX_SERVER_URL,
					});
					const serverUrl = normalizeMlxServerUrl(
						enteredUrl.trim() || process.env.MLX_BASE_URL || DEFAULT_MLX_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					// Verify connectivity before storing the credential.
					const checkResponse = await fetch(`${serverUrl}/models`, {
						signal: AbortSignal.any([interaction.signal, AbortSignal.timeout(15_000)]),
					});
					if (!checkResponse.ok) {
						throw new Error(
							`Could not reach MLX server at ${serverUrl}: ${checkResponse.status} ${checkResponse.statusText}`,
						);
					}
					await checkResponse.json();
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { MLX_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					let serverUrl: string | undefined;
					try {
						serverUrl = await resolveServerUrl(ctx, credential);
					} catch {
						// Misconfigured URL: report unavailable instead of throwing,
						// so one bad URL cannot reject availability for all providers.
						// Login validates loudly instead.
						return undefined;
					}
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "MLX_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("MLX_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: serverUrl },
						env: { ...credential?.env, MLX_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "MLX_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === MLX_PROVIDER_ID && model.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (context.signal.aborted || context.credential?.type !== "api_key") return;
			let serverUrl: string | undefined;
			try {
				serverUrl = credentialServerUrl(context.credential);
			} catch {
				// Misconfigured URL: leave the previous list in place, like a
				// failed fetch below. Login validates loudly instead.
				return;
			}
			if (!serverUrl) return;

			// Server catalog (network) plus local `~/models` discovery (filesystem).
			// `/v1/models` only reports HF-cache entries plus the currently-loaded
			// `--model`, so local checkouts like Ornith 35B or Qwen3.8 variants
			// would otherwise never appear in `/model`. The server loads any
			// absolute-path id on demand, so merged entries are immediately usable.
			let serverData: MlxModelEntry[] | undefined;
			if (context.allowNetwork) {
				try {
					const response = await fetch(`${serverUrl}/models`, {
						signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
					});
					if (!response.ok) {
						throw new Error(`MLX server returned HTTP ${response.status}`);
					}
					const json = (await response.json()) as MlxModelsResponse;
					if (!Array.isArray(json?.data)) throw new Error("MLX server returned an invalid model list");
					serverData = json.data.filter((e): e is MlxModelEntry => typeof e?.id === "string");
				} catch {
					serverData = undefined;
				}
			}
			if (context.signal.aborted) return;

			let localIds: string[] = [];
			try {
				localIds = await discoverLocalMlxModels();
			} catch {
				localIds = [];
			}
			if (context.signal.aborted) return;

			let combined: MlxModelEntry[];
			if (serverData !== undefined) {
				combined = [...serverData];
				const seen = new Set(combined.map((entry) => entry.id));
				for (const id of localIds) {
					if (!seen.has(id)) {
						seen.add(id);
						combined.push({ id, object: "model" });
					}
				}
				if (combined.length === 0) return;
			} else {
				// Server unreachable: keep the restored catalog and only append
				// newly-discovered local models so a failed refresh never drops
				// previously-known HF-cache entries.
				const seen = new Set(models.map((model) => model.id));
				const additions = localIds.filter((id) => !seen.has(id));
				if (additions.length === 0) return;
				combined = [
					...models.map((model) => ({ id: model.id, object: "model" })),
					...additions.map((id) => ({ id, object: "model" })),
				];
			}

			// Best-effort context windows for locally-served models.
			const contextWindows = await Promise.all(
				combined.map(async (e) => ({ id: e.id, cw: await getContextWindowFromLocalConfig(e.id) })),
			);
			const cwMap = new Map(contextWindows.map((r) => [r.id, r.cw]));
			const refreshed = combined.map((e) => toPiModel(e, serverUrl, cwMap.get(e.id)));
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};

	return { provider };
}
