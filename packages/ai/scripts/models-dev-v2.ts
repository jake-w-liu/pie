/**
 * models.dev publishes two catalogs:
 *
 * - `https://models.dev/api.json` is the legacy schema the per-provider rules in
 *   `generate-models.ts` were written against. It keeps serving stable metadata
 *   but omits newer models and carries no entry type.
 * - `https://models.dev/experimental/v2.0/api.json` types every entry (`chat`,
 *   `realtime`, `image`, ...) and lists models the legacy catalog does not,
 *   e.g. `chat-latest`, `gpt-5.6-cyber`, and `gemini-robotics-er-2-preview`.
 *
 * This module reads both: the legacy catalog stays authoritative for every model
 * it lists, and the v2-only chat models are normalized into the legacy shape so
 * the existing provider rules pick them up without changing their behavior.
 */
import type { ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_V2_URL = "https://models.dev/experimental/v2.0/api.json";

/** The legacy models.dev shape consumed by the provider rules in generate-models.ts. */
export interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

export interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

type LegacyEffortValue = Exclude<Extract<ModelsDevReasoningOption, { type: "effort" }>["values"][number], null>;

interface ModelsDevV2CachePrices {
	read?: number;
	write?: number | Record<string, number>;
	explicit?: { read?: number; write?: number | Record<string, number> };
}

interface ModelsDevV2CostOverride {
	when?: Record<string, unknown>;
	price?: number;
	cache?: ModelsDevV2CachePrices;
}

interface ModelsDevV2ModalityCost {
	unit?: string;
	price: number;
	cache?: ModelsDevV2CachePrices;
	overrides?: ModelsDevV2CostOverride[];
}

interface ModelsDevV2ApiEntry {
	base_url?: string;
	sdk?: { aisdk?: string };
}

/**
 * The subset of a v2 model this module reads. The v2 schema is published as
 * experimental, so unknown fields are ignored rather than trusted.
 */
export interface ModelsDevV2Model {
	id: string;
	type: string;
	name?: string;
	status?: string;
	modalities?: { input?: string[]; output?: string[] };
	capabilities?: {
		tools?: { supported?: boolean };
		reasoning?: {
			supported?: boolean;
			toggle?: boolean;
			effort?: string[];
			budget?: { min?: number; max?: number };
		};
		structured_output?: boolean;
	};
	limit?: { context?: number; input?: number; output?: number };
	cost?: { text?: { input?: ModelsDevV2ModalityCost; output?: ModelsDevV2ModalityCost } };
	api?: Record<string, ModelsDevV2ApiEntry>;
	recommended_api?: string;
}

export type ModelsDevV2Catalog = Record<string, { models?: Record<string, ModelsDevV2Model> }>;

/**
 * v1 field the provider rules use to pick a wire protocol for router providers.
 * v2 states the protocol per API entry instead, so map its AI SDK package back
 * onto the legacy npm values; unknown SDKs fall back to the chat-completions
 * protocol like the legacy catalog's missing/`@ai-sdk/openai-compatible` value.
 */
const AI_SDK_NPM: Record<string, string> = {
	"@ai-sdk/alibaba": "@ai-sdk/alibaba",
	"@ai-sdk/anthropic": "@ai-sdk/anthropic",
	"@ai-sdk/google": "@ai-sdk/google",
	"@ai-sdk/openai": "@ai-sdk/openai",
};

const THINKING_LEVELS = new Set<string>([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"none",
	"default",
]);

function isLegacyEffort(value: string): value is LegacyEffortValue {
	return THINKING_LEVELS.has(value);
}

function firstCacheWrite(write: number | Record<string, number> | undefined): number | undefined {
	return typeof write === "object" ? Object.values(write)[0] : write;
}

function cacheWritePrice(cache: ModelsDevV2CachePrices | undefined): number | undefined {
	return firstCacheWrite(cache?.write) ?? firstCacheWrite(cache?.explicit?.write);
}

/** Context-size override threshold. Other v2 override dimensions have no legacy equivalent. */
function contextThreshold(when: Record<string, unknown> | undefined): number | undefined {
	if (!when) return undefined;
	const keys = Object.keys(when);
	if (keys.length !== 1 || keys[0] !== "context") return undefined;
	const context = when.context as { gt?: unknown; gte?: unknown } | undefined;
	const size = context?.gt ?? context?.gte;
	return typeof size === "number" ? size : undefined;
}

/**
 * Convert v2 prices to the legacy cost shape. Tiers missing a rate inherit the
 * base rate, because the provider rules read every tier rate without fallback.
 */
function legacyCost(cost: ModelsDevV2Model["cost"]): NonNullable<ModelsDevModel["cost"]> {
	const input = cost?.text?.input;
	const output = cost?.text?.output;
	if (!input || !output) return {};
	if (input.unit !== undefined && input.unit !== "token") return {};
	if (output.unit !== undefined && output.unit !== "token") return {};

	const base = {
		input: input.price,
		output: output.price,
		cache_read: input.cache?.read ?? 0,
		cache_write: cacheWritePrice(input.cache) ?? 0,
	};

	const tiers = new Map<number, NonNullable<NonNullable<ModelsDevModel["cost"]>["tiers"]>[number]>();
	const tier = (size: number) => {
		let entry = tiers.get(size);
		if (!entry) {
			entry = { tier: { type: "context", size } };
			tiers.set(size, entry);
		}
		return entry;
	};

	for (const override of input.overrides ?? []) {
		const size = contextThreshold(override.when);
		if (size === undefined) continue;
		const entry = tier(size);
		if (override.price !== undefined) entry.input = override.price;
		if (override.cache?.read !== undefined) entry.cache_read = override.cache.read;
		const write = cacheWritePrice(override.cache);
		if (write !== undefined) entry.cache_write = write;
	}
	for (const override of output.overrides ?? []) {
		const size = contextThreshold(override.when);
		if (size === undefined) continue;
		const entry = tier(size);
		if (override.price !== undefined) entry.output = override.price;
	}

	for (const entry of tiers.values()) {
		entry.input ??= base.input;
		entry.output ??= base.output;
		entry.cache_read ??= base.cache_read;
		entry.cache_write ??= base.cache_write;
	}

	return {
		...base,
		...(tiers.size > 0 ? { tiers: [...tiers.values()] } : {}),
	};
}

function legacyReasoningOptions(model: ModelsDevV2Model): ModelsDevReasoningOption[] | undefined {
	const reasoning = model.capabilities?.reasoning;
	if (!reasoning?.supported) return undefined;
	const options: ModelsDevReasoningOption[] = [];
	if (reasoning.toggle) options.push({ type: "toggle" });
	if (reasoning.effort !== undefined) {
		const values = reasoning.effort.filter(isLegacyEffort);
		if (values.length > 0) options.push({ type: "effort", values });
	}
	if (reasoning.budget !== undefined) {
		const { min, max } = reasoning.budget;
		options.push({
			type: "budget_tokens",
			...(min !== undefined ? { min } : {}),
			...(max !== undefined ? { max } : {}),
		});
	}
	return options.length > 0 ? options : undefined;
}

function legacyNpm(model: ModelsDevV2Model): string | undefined {
	const apis = model.api ?? {};
	const keys = model.recommended_api !== undefined && apis[model.recommended_api] ? [model.recommended_api] : [];
	for (const key of [...keys, ...Object.keys(apis)]) {
		const aisdk = apis[key]?.sdk?.aisdk;
		if (aisdk === undefined) continue;
		return AI_SDK_NPM[aisdk] ?? "@ai-sdk/openai-compatible";
	}
	return undefined;
}

/**
 * Normalize one v2 entry into the legacy shape, or drop it when the provider
 * rules cannot serve it as a chat model.
 *
 * `type: "chat"` also covers speech models such as `gpt-audio`, which answer on
 * the chat-completions audio path and only emit audio alongside text; pi's
 * provider adapters drive text chat APIs, so keep entries that answer in text.
 */
export function toModelsDevModel(model: ModelsDevV2Model): ModelsDevModel | undefined {
	if (model.type !== "chat") return undefined;
	if (model.capabilities?.tools?.supported !== true) return undefined;

	const output = model.modalities?.output ?? [];
	if (!output.includes("text")) return undefined;
	if (output.some((entry) => entry.startsWith("audio/"))) return undefined;

	const input = model.modalities?.input ?? [];
	const inputModalities: string[] = [];
	if (input.includes("text")) inputModalities.push("text");
	if (input.some((entry) => entry === "image" || entry.startsWith("image/"))) inputModalities.push("image");

	const reasoningOptions = legacyReasoningOptions(model);
	const npm = legacyNpm(model);
	return {
		id: model.id,
		name: model.name ?? model.id,
		tool_call: true,
		...(model.capabilities?.structured_output === true ? { structured_output: true } : {}),
		reasoning: model.capabilities?.reasoning?.supported === true,
		...(reasoningOptions !== undefined ? { reasoning_options: reasoningOptions } : {}),
		...(model.status !== undefined ? { status: model.status } : {}),
		limit: {
			...(model.limit?.context !== undefined ? { context: model.limit.context } : {}),
			...(model.limit?.output !== undefined ? { output: model.limit.output } : {}),
		},
		cost: legacyCost(model.cost),
		modalities: {
			input: inputModalities,
			output: ["text"],
		},
		...(npm !== undefined ? { provider: { npm } } : {}),
	};
}

/**
 * Append the v2-only chat models to the legacy catalog. Models the legacy
 * catalog already lists keep their existing metadata, so this can only add
 * entries; it never rewrites models the provider rules were tuned against.
 */
export function addModelsDevV2ChatModels(
	legacy: ModelsDevCatalog,
	v2: ModelsDevV2Catalog,
): ModelsDevCatalog {
	const catalog: ModelsDevCatalog = {};
	for (const [providerId, provider] of Object.entries(legacy)) {
		catalog[providerId] = { models: { ...(provider.models ?? {}) } };
	}
	for (const [providerId, provider] of Object.entries(v2)) {
		for (const [modelId, model] of Object.entries(provider.models ?? {})) {
			if (catalog[providerId]?.models?.[modelId] !== undefined) continue;
			const converted = toModelsDevModel(model);
			if (!converted) continue;
			const destination = (catalog[providerId] ??= {});
			destination.models ??= {};
			destination.models[modelId] = converted;
		}
	}
	return catalog;
}

/** Fetch both catalogs and merge them. Throws when either source is unavailable. */
export async function loadModelsDevCatalog(): Promise<ModelsDevCatalog> {
	const [legacyResponse, v2Response] = await Promise.all([fetch(MODELS_DEV_URL), fetch(MODELS_DEV_V2_URL)]);
	if (!legacyResponse.ok) throw new Error(`models.dev API returned ${legacyResponse.status}`);
	if (!v2Response.ok) throw new Error(`models.dev v2 API returned ${v2Response.status}`);
	const legacy = (await legacyResponse.json()) as ModelsDevCatalog;
	const v2 = (await v2Response.json()) as ModelsDevV2Catalog;
	return addModelsDevV2ChatModels(legacy, v2);
}
