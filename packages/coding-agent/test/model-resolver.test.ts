import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveCliModel, resolveModelScopeFromModels } from "../src/core/model-resolver.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function runtime(models: Model<Api>[], authenticated: string[]): ModelRuntime {
	const auth = new Set(authenticated);
	return {
		getModels: () => models,
		hasConfiguredAuth: (provider: string) => auth.has(provider),
	} as unknown as ModelRuntime;
}

describe("model resolver", () => {
	const models = [
		model("anthropic", "other"),
		model("openrouter", "anthropic/shared"),
		model("vercel-ai-gateway", "anthropic/shared"),
	];

	it("applies exact-match authentication policy after failed provider inference", () => {
		const selected = resolveCliModel({
			cliModel: "anthropic/shared",
			modelRuntime: runtime(models, ["vercel-ai-gateway"]),
		});
		expect(selected.model?.provider).toBe("vercel-ai-gateway");

		const unauthenticated = resolveCliModel({ cliModel: "anthropic/shared", modelRuntime: runtime(models, []) });
		expect(unauthenticated.model).toBeUndefined();
		expect(unauthenticated.error).toContain("No matching provider is authenticated");

		const multiplyAuthenticated = resolveCliModel({
			cliModel: "anthropic/shared",
			modelRuntime: runtime(models, ["openrouter", "vercel-ai-gateway"]),
		});
		expect(multiplyAuthenticated.model).toBeUndefined();
		expect(multiplyAuthenticated.error).toContain("More than one matching provider is authenticated");
	});

	it("strips and diagnoses an invalid thinking suffix on a glob", () => {
		const result = resolveModelScopeFromModels(["anthropic/*:bogus"], [model("anthropic", "shared")]);

		expect(result.scopedModels).toMatchObject([{ model: { id: "shared" }, thinkingLevel: undefined }]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid-thinking-level", pattern: "anthropic/*:bogus" }),
		]);
	});
});
