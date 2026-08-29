import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function model(): Model<Api> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 10000,
	};
}

describe("interactive model persistence", () => {
	it("remembers an exact /model selection for the next startup", async () => {
		const selectedModel = model();
		const context = {
			findExactModelMatch: vi.fn(async () => selectedModel),
			session: { setModel: vi.fn(async () => undefined) },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => undefined),
			checkDaxnutsEasterEgg: vi.fn(),
			showError: vi.fn(),
		};
		const handleModelCommand = Reflect.get(InteractiveMode.prototype, "handleModelCommand") as (
			this: typeof context,
			searchTerm?: string,
		) => Promise<void>;

		await handleModelCommand.call(context, "openai/gpt-test");

		expect(context.session.setModel).toHaveBeenCalledWith(selectedModel, { persist: true });
		expect(context.showStatus).toHaveBeenCalledWith("Model: openai/gpt-test (remembered)");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("remembers models selected through keyboard cycling", async () => {
		const selectedModel = model();
		const context = {
			session: {
				cycleModel: vi.fn(async () => ({ model: selectedModel, thinkingLevel: "off" as const, isScoped: false })),
				scopedModels: [],
			},
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => undefined),
			showError: vi.fn(),
		};
		const cycleModel = Reflect.get(InteractiveMode.prototype, "cycleModel") as (
			this: typeof context,
			direction: "forward" | "backward",
		) => Promise<void>;

		await cycleModel.call(context, "forward");

		expect(context.session.cycleModel).toHaveBeenCalledWith("forward", { persist: true });
		expect(context.showStatus).toHaveBeenCalledWith("Switched to GPT Test (remembered)");
		expect(context.showError).not.toHaveBeenCalled();
	});
});
