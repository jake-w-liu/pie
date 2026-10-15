import { describe, expect, it, vi } from "vitest";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

const token = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;
const DELTA_COUNT = 30;
const deltas = Array.from({ length: DELTA_COUNT }, (_, index) => `t${index} `);
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

const cases = [
	{
		name: "Codex SSE",
		run: (options: StreamOptions) =>
			codex(model("openai-codex-responses"), { messages: [] }, { ...options, apiKey: token, transport: "sse" }),
		head: [
			sse({ type: "response.output_item.added", item: { type: "message", id: "msg", content: [] } }),
			sse({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
		],
		delta: (text: string) => sse({ type: "response.output_text.delta", delta: text }),
		tail: [
			sse({
				type: "response.completed",
				response: { id: "res", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			}),
		],
	},
	{
		name: "Mistral",
		run: (options: StreamOptions) =>
			mistral(model("mistral-conversations"), { messages: [] }, { ...options, apiKey: "test" }),
		head: [],
		delta: (text: string) => sse({ choices: [{ delta: { content: text }, finish_reason: null }] }),
		tail: [sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"],
	},
];

/** Emits one chunk per `gapMs`; `cancel` observes the adapter releasing the body. */
function pacedBody(chunks: string[], gapMs: number, cancel: () => void): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			return new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					controller.enqueue(encoder.encode(chunks[index++]));
					if (index === chunks.length) controller.close();
					resolve();
				}, gapMs);
			});
		},
		cancel() {
			clearTimeout(timer);
			cancel();
		},
	});
}

describe.each(cases)("$name timeoutMs", ({ run, head, delta, tail }) => {
	it("bounds idle gaps, not the duration of an active stream", async () => {
		// 30 chunks 10ms apart outlast timeoutMs threefold. A chunk timer is always due
		// before the idle timer armed after the previous chunk, so this cannot flake.
		const chunks = [...head, ...deltas.map(delta), ...tail];
		const result = await run({
			timeoutMs: 100,
			fetch: async () => new Response(pacedBody(chunks, 10, () => {})),
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: deltas.join("") })]);
	});

	it("fails a body that stalls after headers with an idle timeout", async () => {
		const cancel = vi.fn();
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode([...head, delta("partial")].join("")));
			},
			cancel,
		});
		const result = await run({ timeoutMs: 50, fetch: async () => new Response(body) }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("SSE stream idle timeout after 50ms");
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("still bounds the wait for response headers", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const result = await run({ timeoutMs: 20, fetch }).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timed out|aborted due to timeout/);
	});
});
