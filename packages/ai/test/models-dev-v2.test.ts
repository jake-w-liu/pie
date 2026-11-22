import { describe, expect, it } from "vitest";
import {
	addModelsDevV2ChatModels,
	type ModelsDevCatalog,
	type ModelsDevV2Catalog,
	type ModelsDevV2Model,
	toModelsDevModel,
} from "../scripts/models-dev-v2.ts";

const legacySol = {
	id: "gpt-6.2-sol",
	name: "GPT-6.2 Sol",
	tool_call: true,
	reasoning: true,
	limit: { context: 1000, output: 100 },
	cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
	modalities: { input: ["text", "image"], output: ["text"] },
};

const legacy: ModelsDevCatalog = { openai: { models: { "gpt-6.2-sol": legacySol } } };

function v2ChatModel(overrides: Partial<ModelsDevV2Model> = {}): ModelsDevV2Model {
	return {
		id: "gpt-6-cyber",
		type: "chat",
		name: "GPT-6 Cyber",
		modalities: { input: ["text", "image/png", "application/pdf"], output: ["text"] },
		capabilities: {
			tools: { supported: true },
			structured_output: true,
			reasoning: { supported: true, toggle: true, effort: ["low", "high", "unknown-level"] },
		},
		limit: { context: 2000, output: 200 },
		cost: {
			text: {
				input: {
					price: 3,
					cache: { read: 0.3, write: { "30m": 3.75 } },
					overrides: [{ when: { context: { gt: 1000 } }, price: 6, cache: { read: 0.6 } }],
				},
				output: { price: 12, overrides: [{ when: { context: { gt: 1000 } }, price: 18 }] },
			},
		},
		...overrides,
	};
}

function v2Catalog(model: ModelsDevV2Model): ModelsDevV2Catalog {
	return { openai: { models: { [model.id]: model } } };
}

describe("toModelsDevModel", () => {
	it("normalizes a v2 chat model into the legacy shape", () => {
		expect(toModelsDevModel(v2ChatModel())).toEqual({
			id: "gpt-6-cyber",
			name: "GPT-6 Cyber",
			tool_call: true,
			structured_output: true,
			reasoning: true,
			reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
			limit: { context: 2000, output: 200 },
			cost: {
				input: 3,
				output: 12,
				cache_read: 0.3,
				cache_write: 3.75,
				tiers: [
					{
						tier: { type: "context", size: 1000 },
						input: 6,
						output: 18,
						// Rates the override does not name inherit the base rates.
						cache_read: 0.6,
						cache_write: 3.75,
					},
				],
			},
			modalities: { input: ["text", "image"], output: ["text"] },
		});
	});

	it("maps the recommended API's AI SDK package onto the legacy npm field", () => {
		const model = v2ChatModel({
			api: {
				messages: { base_url: "https://example.test", sdk: { aisdk: "@ai-sdk/anthropic" } },
				"chat-completions": { base_url: "https://example.test", sdk: { aisdk: "@ai-sdk/openai-compatible" } },
			},
			recommended_api: "messages",
		});

		expect(toModelsDevModel(model)?.provider).toEqual({ npm: "@ai-sdk/anthropic" });
	});

	it("omits effort values pi cannot represent", () => {
		const model = v2ChatModel({
			capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["unknown-level"] } },
		});

		expect(toModelsDevModel(model)?.reasoning_options).toBeUndefined();
	});

	it("drops entries that are not tool-capable chat models", () => {
		expect(toModelsDevModel(v2ChatModel({ type: "realtime" }))).toBeUndefined();
		expect(toModelsDevModel(v2ChatModel({ capabilities: { tools: { supported: false } } }))).toBeUndefined();
	});

	it("drops speech models whose output is not text-only", () => {
		expect(
			toModelsDevModel(v2ChatModel({ modalities: { input: ["text"], output: ["text", "audio/wav"] } })),
		).toBeUndefined();
	});
});

describe("addModelsDevV2ChatModels", () => {
	it("appends v2-only chat models without rewriting legacy entries", () => {
		const merged = addModelsDevV2ChatModels(legacy, v2Catalog(v2ChatModel()));

		expect(merged.openai?.models?.["gpt-6.2-sol"]).toBe(legacySol);
		expect(merged.openai?.models?.["gpt-6-cyber"]?.name).toBe("GPT-6 Cyber");
	});

	it("does not replace a legacy entry that also exists in v2", () => {
		const v2Model = v2ChatModel({ id: "gpt-6.2-sol", name: "GPT-6.2 Sol (v2)" });
		const merged = addModelsDevV2ChatModels(legacy, v2Catalog(v2Model));

		expect(merged.openai?.models?.["gpt-6.2-sol"]).toBe(legacySol);
	});

	it("keeps legacy providers the v2 catalog does not list", () => {
		const merged = addModelsDevV2ChatModels(legacy, {});
		expect(merged.openai?.models?.["gpt-6.2-sol"]).toBe(legacySol);
	});
});
