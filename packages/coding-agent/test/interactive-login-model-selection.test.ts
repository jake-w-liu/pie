import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function model(provider: string, id: string, api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function createContext(availableModels: Model<Api>[]) {
	return {
		session: {
			modelRuntime: {
				getAvailableSnapshot: vi.fn(() => availableModels),
				refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			},
			setModel: vi.fn(async () => undefined),
		},
		updateAvailableProviderCount: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		checkDaxnutsEasterEgg: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
}

const completeProviderAuthentication = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
	this: ReturnType<typeof createContext>,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
	previousModel: Model<Api> | undefined,
) => Promise<void>;

describe("interactive login model selection", () => {
	it("switches to and persists the authenticated provider default when login changes providers", async () => {
		const current = model("deepseek", "deepseek-v4-pro", "openai-completions");
		const target = model("openai-codex", defaultModelPerProvider["openai-codex"], "openai-codex-responses");
		const context = createContext([target]);

		await completeProviderAuthentication.call(context, "openai-codex", "OpenAI Codex", "oauth", current);

		expect(context.session.setModel).toHaveBeenCalledOnce();
		expect(context.session.setModel).toHaveBeenCalledWith(target, { persist: true });
		expect(context.showStatus).toHaveBeenCalledWith(
			expect.stringContaining(`Logged in to OpenAI Codex. Selected ${target.id}.`),
		);
	});

	it("preserves the current model when reauthenticating its provider", async () => {
		const current = model("openai-codex", "gpt-5.6-luna", "openai-codex-responses");
		const providerDefault = model("openai-codex", defaultModelPerProvider["openai-codex"], "openai-codex-responses");
		const context = createContext([providerDefault, current]);

		await completeProviderAuthentication.call(context, "openai-codex", "OpenAI Codex", "oauth", current);

		expect(context.session.setModel).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("Logged in to OpenAI Codex."));
	});

	it("selects the provider default when no model was previously selected", async () => {
		const target = model("openai-codex", defaultModelPerProvider["openai-codex"], "openai-codex-responses");
		const context = createContext([target]);

		await completeProviderAuthentication.call(context, "openai-codex", "OpenAI Codex", "oauth", undefined);

		expect(context.session.setModel).toHaveBeenCalledWith(target, { persist: true });
	});
});
