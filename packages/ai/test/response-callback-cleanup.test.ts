import { describe, expect, it, vi } from "vitest";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test",
		name: "Test",
		api,
		provider: "test",
		baseUrl: "https://upstream.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}
const cases = [
	{
		name: "completions",
		run: (options: StreamOptions) => completions(model("openai-completions"), { messages: [] }, options),
	},
	{
		name: "responses",
		run: (options: StreamOptions) => responses(model("openai-responses"), { messages: [] }, options),
	},
	{
		name: "azure",
		run: (options: StreamOptions) => azure(model("azure-openai-responses"), { messages: [] }, options),
	},
	{
		name: "mistral",
		run: (options: StreamOptions) => mistral(model("mistral-conversations"), { messages: [] }, options),
	},
];
describe.each(cases)("$name callback body ownership", ({ run }) => {
	it.each([false, true])(
		"cancels before terminalizing a rejected callback (cleanup rejects: %s)",
		async (cleanupRejects) => {
			const cancel = vi.fn(() => {
				if (cleanupRejects) throw new Error("cleanup failed");
			});
			const body = new ReadableStream<Uint8Array>({ cancel });
			const request = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
			const result = await run({
				apiKey: "test",
				maxRetries: 0,
				fetch: request,
				onResponse: async () => {
					throw new Error("callback rejected");
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("callback rejected");
			expect(cancel).toHaveBeenCalledOnce();
			expect(request).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
		},
	);
});
