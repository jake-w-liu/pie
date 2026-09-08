import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

const failed: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "test",
	provider: "test",
	model: "test",
	timestamp: 0,
	stopReason: "error",
	errorMessage: "503 unavailable",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const model: Model<"openai-codex-responses"> = {
	id: "test",
	name: "Test",
	api: "openai-codex-responses",
	provider: "test",
	baseUrl: "https://upstream.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
afterEach(() => {
	vi.useRealTimers();
});
it.each(["assistant", "codex"])(
	"removes listeners after repeated %s backoffs and interrupts an active sleep",
	async (kind) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const run = () =>
			kind === "assistant"
				? retryAssistantCall(
						async () => failed,
						{ enabled: true, baseDelayMs: 1, maxRetries: 4 },
						controller.signal,
					)
				: stream(
						model,
						{ messages: [] },
						{
							apiKey: `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.sig`,
							transport: "sse",
							signal: controller.signal,
							maxRetries: 4,
							fetch: async () =>
								new Response("temporarily unavailable", { status: 503, headers: { "retry-after-ms": "1" } }),
						},
					).result();
		for (let index = 0; index < 3; index++) {
			const result = run();
			await vi.runAllTimersAsync();
			expect((await result).stopReason).toBe("error");
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		}
		const pending = run();
		await vi.advanceTimersByTimeAsync(0);
		expect(getEventListeners(controller.signal, "abort").length).toBeGreaterThan(0);
		controller.abort();
		expect((await pending).stopReason).toBe("aborted");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	},
);
