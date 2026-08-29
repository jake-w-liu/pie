import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { fetchNvidiaModels, fetchOpenRouterModels } from "../src/providers/openai-completions-models.ts";

function response(body: unknown, ok = true, status = 200): Response {
	return new Response(ok ? JSON.stringify(body) : JSON.stringify({ error: "boom" }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function context(): RefreshModelsContext {
	const controller = new AbortController();
	return {
		stored: undefined,
		allowNetwork: true,
		force: true,
		signal: controller.signal,
		publish: async () => true,
		credential: undefined,
	};
}

describe("openai-completions-models", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("maps NVIDIA bare id entries, filters non-chat models, and skips baseline ids", async () => {
		const fetchMock = vi.fn(async () =>
			response({
				data: [
					{ id: "deepseek-ai/deepseek-v4-flash-0731" },
					{ id: "google/gemma-3-12b-it" },
					{ id: "meta/llama-3.1-nemotron-70b-instruct" },
					{ id: "nvidia/embed-qa-4" },
					{ id: "nvidia/llama-3.1-nemoguard-8b-content-safety" },
					{ id: "bigcode/starcoder2-15b" },
					{ id: "nvidia/nemotron-3-ultra-550b-a55b" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const baseline = new Set(["deepseek-ai/deepseek-v4-flash-0731"]);
		const models = await fetchNvidiaModels(context(), baseline);

		// Baseline id is skipped to preserve its richer metadata.
		// Embeddings, safety guards, and code-only models are filtered out.
		expect(models.map((m) => m.id).sort()).toEqual([
			"google/gemma-3-12b-it",
			"meta/llama-3.1-nemotron-70b-instruct",
			"nvidia/nemotron-3-ultra-550b-a55b",
		]);

		const ultra = models.find((m) => m.id === "nvidia/nemotron-3-ultra-550b-a55b")!;
		expect(ultra.provider).toBe("nvidia");
		expect(ultra.api).toBe("openai-completions");
		expect(ultra.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
		expect(ultra.contextWindow).toBe(128_000);
		expect(ultra.maxTokens).toBe(8_192);
		expect(ultra.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(ultra.compat?.maxTokensField).toBe("max_tokens");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://integrate.api.nvidia.com/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ accept: "application/json" }) }),
		);
	});

	it("includes only tool-capable OpenRouter models with full metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					data: [
						{
							id: "deepseek/deepseek-chat",
							name: "DeepSeek Chat",
							supported_parameters: ["tools", "reasoning"],
							architecture: { modality: "text" },
							pricing: { prompt: "0.5", completion: "1.5", input_cache_read: "0.25", input_cache_write: "0.75" },
							top_provider: { context_length: 128000, max_completion_tokens: 8192 },
						},
						{
							id: "meta/llama-3.3-70b",
							name: "Llama 3.3",
							supported_parameters: ["temperature"],
							architecture: { modality: "text" },
						},
					],
				}),
			),
		);

		const models = await fetchOpenRouterModels(context());

		expect(models).toHaveLength(1);
		const m = models[0];
		expect(m.id).toBe("deepseek/deepseek-chat");
		expect(m.reasoning).toBe(true);
		expect(m.contextWindow).toBe(128000);
		expect(m.maxTokens).toBe(8192);
		expect(m.cost.input).toBe(500000);
		expect(m.cost.output).toBe(1500000);
		expect(m.cost.cacheRead).toBe(250000);
		expect(m.cost.cacheWrite).toBe(750000);
	});

	it("throws on non-2xx so the caller can fall back to the persisted catalog", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({}, false, 500)),
		);
		await expect(fetchNvidiaModels(context(), new Set())).rejects.toThrow(/HTTP 500/);
	});
});
