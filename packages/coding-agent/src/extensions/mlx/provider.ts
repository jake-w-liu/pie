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
		const parts = id.split("/");
		return parts[parts.length - 1] || id;
	}
	return id;
}

/**
 * Best-effort context window from a locally-served model's config.json.
 * MLX servers report only id/object/created for `/v1/models`, so we read the
 * model directory directly when the id is an absolute local path.
 */
async function getContextWindowFromLocalConfig(modelId: string): Promise<number | undefined> {
	if (!modelId.startsWith("/")) return undefined;
	try {
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const text = await readFile(join(modelId, "config.json"), "utf8");
		const config = JSON.parse(text) as Record<string, unknown>;
		const ctx = config.max_position_embeddings;
		return typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : undefined;
	} catch {
		return undefined;
	}
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
					const checkResponse = await fetch(`${serverUrl}/models`, { signal: interaction.signal });
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
					const serverUrl = await resolveServerUrl(ctx, credential);
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

			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;

			let data: MlxModelEntry[];
			try {
				const response = await fetch(`${serverUrl}/models`, { signal: context.signal });
				if (!response.ok) {
					throw new Error(`MLX server returned HTTP ${response.status}`);
				}
				const json = (await response.json()) as MlxModelsResponse;
				if (!Array.isArray(json?.data)) throw new Error("MLX server returned an invalid model list");
				data = json.data.filter((e): e is MlxModelEntry => typeof e?.id === "string");
			} catch {
				// Leave the previous list in place; a failed refresh is not fatal.
				return;
			}
			if (context.signal.aborted) return;

			// Best-effort context windows for locally-served models.
			const contextWindows = await Promise.all(
				data.map(async (e) => ({ id: e.id, cw: await getContextWindowFromLocalConfig(e.id) })),
			);
			const cwMap = new Map(contextWindows.map((r) => [r.id, r.cw]));
			const refreshed = data.map((e) => toPiModel(e, serverUrl, cwMap.get(e.id)));
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
