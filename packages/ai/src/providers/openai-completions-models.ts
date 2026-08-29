import type { RefreshModelsContext } from "../models.ts";
import type { Model, OpenAICompletionsCompat } from "../types.ts";

/**
 * Live model discovery for OpenAI-compatible `GET /models` endpoints.
 *
 * Built-in OpenAI-completions providers ship a static baseline catalog
 * generated at release time. `fetchModels` overlays that baseline with the
 * provider's *current* model list fetched at runtime, so the `/model` picker
 * reflects models added since the last release without requiring a code or
 * catalog update. Fetched lists are persisted through the `ModelsStore` and
 * restored for offline use.
 */

export interface OpenAIModelsListEntry {
	id: string;
	name?: string;
	object?: string;
	created?: number;
	owned_by?: string;
	context_window?: number;
	context_length?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	supported_parameters?: string[];
	architecture?: { modality?: string };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
}

interface OpenAIModelsListResponse {
	data?: OpenAIModelsListEntry[];
}

export interface FetchOpenAIModelsOptions {
	/** Provider id stamped on every fetched model. */
	provider: string;
	/** Endpoint root, e.g. `https://integrate.api.nvidia.com/v1`. */
	baseUrl: string;
	/** Compatibility overrides merged into every fetched model. */
	compat?: OpenAICompletionsCompat;
	/** Extra request headers (e.g. NVIDIA polling hints). */
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/**
	 * Ids already covered by the static baseline. They are skipped so the
	 * baseline's richer metadata (context window, reasoning flags, pricing)
	 * is preserved instead of being overwritten by endpoint defaults.
	 */
	excludeIds?: ReadonlySet<string>;
	/** Drop entries for which this returns false (e.g. non-chat models). */
	include?: (entry: OpenAIModelsListEntry) => boolean;
	/** Whether a listed model supports extended reasoning/thinking. */
	isReasoning?: (entry: OpenAIModelsListEntry) => boolean;
	/** Default context window in tokens when the endpoint omits it. */
	defaultContextWindow?: number;
	/** Default max output tokens when the endpoint omits it. */
	defaultMaxTokens?: number;
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function costFromPricing(pricing: OpenAIModelsListEntry["pricing"]): Model<"openai-completions">["cost"] {
	if (!pricing) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const toPerMillion = (value: string | undefined): number => {
		const parsed = parseFloat(value ?? "0");
		return Number.isFinite(parsed) ? roundCost(parsed * 1_000_000) : 0;
	};
	return {
		input: toPerMillion(pricing.prompt),
		output: toPerMillion(pricing.completion),
		cacheRead: toPerMillion(pricing.input_cache_read),
		cacheWrite: toPerMillion(pricing.input_cache_write),
	};
}

/**
 * Fetch and map a provider's `GET /models` list into pi model objects.
 * Throws on transport or non-2xx failure so the caller can fall back to the
 * persisted catalog.
 */
export async function fetchOpenAIModels(options: FetchOpenAIModelsOptions): Promise<Model<"openai-completions">[]> {
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const response = await fetch(`${baseUrl}/models`, {
		headers: { accept: "application/json", ...(options.headers ?? {}) },
		signal: options.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not fetch models from ${options.provider}: HTTP ${response.status}`);
	}
	const payload = (await response.json()) as OpenAIModelsListResponse;
	const entries = Array.isArray(payload.data) ? payload.data : [];
	const isReasoning = options.isReasoning ?? (() => false);
	const excludeIds = options.excludeIds;
	const defaultContextWindow = options.defaultContextWindow ?? 128_000;
	const defaultMaxTokens = options.defaultMaxTokens ?? 8_192;

	const models: Model<"openai-completions">[] = [];
	for (const entry of entries) {
		if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
		if (excludeIds?.has(entry.id)) continue;
		if (options.include && !options.include(entry)) continue;

		const input: ("text" | "image")[] = ["text"];
		if (entry.architecture?.modality?.includes("image")) input.push("image");

		models.push({
			id: entry.id,
			name: entry.name || entry.id,
			api: "openai-completions",
			provider: options.provider,
			baseUrl,
			reasoning: isReasoning(entry),
			input,
			cost: costFromPricing(entry.pricing),
			contextWindow:
				entry.context_window ?? entry.top_provider?.context_length ?? entry.context_length ?? defaultContextWindow,
			maxTokens: entry.max_tokens ?? entry.top_provider?.max_completion_tokens ?? defaultMaxTokens,
			...(options.compat ? { compat: options.compat } : {}),
		});
	}
	return models;
}

/**
 * Fetch NVIDIA NIM models from the provider's own `/models` endpoint.
 *
 * NVIDIA returns bare `{ id }` entries with no context/thinking/tool metadata,
 * so we keep the static baseline (which carries full metadata) and only add
 * ids not already present, filtering out non-chat endpoints (embeddings,
 * safety guards, classifiers, code-only, and vision-only models).
 */
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_HEADERS = { "NVCF-POLL-SECONDS": "3600" } as const;
const NVIDIA_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

const NVIDIA_NON_CHAT_ID_PATTERNS: RegExp[] = [
	/embed/i,
	/nemoretriever/i,
	/nvclip/i,
	/guard/i,
	/safety/i,
	/reward/i,
	/classifier/i,
	/detector/i,
	/detection/i,
	/calibration/i,
	/riva/i,
	/translate/i,
	/codegemma/i,
	/codellama/i,
	/codestral/i,
	/starcoder/i,
	/deepseek-coder/i,
	/granite.*code/i,
	/codegen/i,
	/fuyu/i,
	/kosmos/i,
	/deplot/i,
	/diffusion/i,
	/\/vila$/i,
	/\/neva/i,
	/recurrentgemma/i,
	/phi-3-vision/i,
	/ai-synthetic-video-detector/i,
	/(\/|-)parse$/i,
];

// Known non-chat or incompatible NIM endpoints (mirrors the generate-models
// blacklist for ids the pattern list does not already cover).
const NVIDIA_NON_CHAT_IDS = new Set([
	"google/gemma-4-31b-it",
	"mistralai/mistral-nemotron",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);

function isNvidiaChatModel(entry: OpenAIModelsListEntry): boolean {
	if (NVIDIA_NON_CHAT_IDS.has(entry.id)) return false;
	return !NVIDIA_NON_CHAT_ID_PATTERNS.some((pattern) => pattern.test(entry.id));
}

export async function fetchNvidiaModels(
	context: RefreshModelsContext,
	baselineIds: ReadonlySet<string>,
): Promise<Model<"openai-completions">[]> {
	return fetchOpenAIModels({
		provider: "nvidia",
		baseUrl: NVIDIA_BASE_URL,
		compat: NVIDIA_COMPAT,
		headers: { ...NVIDIA_HEADERS },
		signal: context.signal,
		excludeIds: baselineIds,
		include: isNvidiaChatModel,
		defaultContextWindow: 128_000,
		defaultMaxTokens: 8_192,
	});
}

/**
 * Fetch the live OpenRouter model list. OpenRouter exposes full metadata
 * (context length, max tokens, pricing, tool and reasoning support), so
 * fetched models replace baseline entries of the same id with current values.
 */
export async function fetchOpenRouterModels(context: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	return fetchOpenAIModels({
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		signal: context.signal,
		include: (entry) => entry.supported_parameters?.includes("tools") ?? false,
		isReasoning: (entry) => entry.supported_parameters?.includes("reasoning") ?? false,
	});
}
