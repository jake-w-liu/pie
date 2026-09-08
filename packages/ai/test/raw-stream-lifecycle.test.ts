import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as piMessages } from "../src/api/pi-messages.ts";
import type { Api, AssistantMessageEvent, Model, StreamOptions } from "../src/types.ts";

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
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const cases = [
	{
		name: "Mistral",
		run: (options: StreamOptions) => mistral(model("mistral-conversations"), { messages: [] }, options),
		events: [
			{ type: "message", choices: [{ delta: { content: "héllo" }, finish_reason: null }] },
			{ type: "message", choices: [{ delta: {}, finish_reason: "stop" }] },
		],
	},
	{
		name: "Anthropic",
		run: (options: StreamOptions) => anthropic(model("anthropic-messages"), { messages: [] }, options),
		events: [
			{ type: "message_start", message: { id: "msg", model: "test-model", usage: { input_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		],
	},
	{
		name: "Codex",
		run: (options: StreamOptions) => codex(model("openai-codex-responses"), { messages: [] }, options),
		events: [
			{ type: "response.output_item.added", item: { type: "message", id: "msg", content: [] } },
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "héllo" },
			{
				type: "response.completed",
				response: { id: "res", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			},
		],
	},
	{
		name: "pi-messages",
		run: (options: StreamOptions) => piMessages(model("pi-messages"), { messages: [] }, options),
		events: [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "héllo" },
			{ type: "done", reason: "stop", usage },
		],
	},
];
function encode(events: { type: string }[], newline = "\n"): Uint8Array {
	return new TextEncoder().encode(
		events
			.map((event) => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`)
			.join(""),
	);
}
const options = { apiKey: token, transport: "sse", maxRetries: 0 } as const;

describe.each(cases)("$name raw stream lifecycle", ({ name, run, events }) => {
	it.each(["\n", "\r\n", "\r"])("decodes every byte split with %j framing", async (newline) => {
		const bytes = encode(events, newline);
		for (let split = 0; split <= bytes.length; split++) {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.slice(0, split));
					controller.enqueue(bytes.slice(split));
					controller.close();
				},
			});
			const result = await run({ ...options, fetch: async () => new Response(body) }).result();
			expect(result.stopReason, `split ${split}: ${result.errorMessage}`).toBe("stop");
			expect(result.content[0]).toMatchObject({ type: "text", text: "héllo" });
			expect(body.locked).toBe(false);
		}
	});
	it("releases a still-open body after the terminal event", async () => {
		const cancel = vi.fn();
		const terminal = encode(events);
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(terminal);
				// OpenAI-compatible Mistral streams use [DONE] as the framing terminator.
				if (name === "Mistral") c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
			},
			cancel,
		});
		const result = await run({ ...options, fetch: async () => new Response(body) }).result();
		expect(result.stopReason).toBe("stop");
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	}, 1000);
	it("cancels a body acquired before onResponse rejects", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const result = await run({
			...options,
			fetch: async () => new Response(body),
			onResponse: async () => {
				throw new Error("callback failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("callback failed");
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});
	it("interrupts an idle reader on abort and removes listeners", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(encode(events.slice(0, 3)));
			},
			cancel,
		});
		const stream = run({ ...options, signal: controller.signal, fetch: async () => new Response(body) });
		for await (const event of stream) {
			if (event.type === "text_delta") controller.abort();
			else if (event.type === "text_start") setTimeout(() => controller.abort(), 0);
		}
		expect((await stream.result()).stopReason).toBe("aborted");
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	}, 1000);
});

it.each([
	1n,
	(() => {
		const value: { self?: unknown } = {};
		value.self = value;
		return value;
	})(),
	Object.create(null),
	(() => {
		const value = Object.create(null);
		value.self = value;
		return value;
	})(),
])(
	"Anthropic terminalizes non-Error thrown values (%#)",
	async (value: unknown) => {
		const events: AssistantMessageEvent[] = [];
		const stream = anthropic(
			model("anthropic-messages"),
			{ messages: [] },
			{
				apiKey: "test",
				onPayload: () => {
					throw value;
				},
				fetch: async () => {
					throw new Error("must not fetch");
				},
			},
		);
		for await (const event of stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect((await stream.result()).errorMessage).toBeTypeOf("string");
	},
	1000,
);

it.each(["eof", "read error", "malformed JSON", "abort"])(
	"pi-messages retains all partial content after %s",
	async (failure) => {
		const controller = new AbortController();
		let source: ReadableStreamDefaultController<Uint8Array>;
		const partial = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "received" },
			{ type: "thinking_start", contentIndex: 1 },
			{ type: "thinking_delta", contentIndex: 1, delta: "reasoning" },
			{ type: "toolcall_start", contentIndex: 2, id: "call", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"key":"value"' },
		];
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				source = c;
				c.enqueue(encode(partial));
			},
		});
		const stream = piMessages(
			model("pi-messages"),
			{ messages: [] },
			{ apiKey: "test", signal: controller.signal, fetch: async () => new Response(body) },
		);
		for await (const event of stream) {
			if (event.type !== "toolcall_delta") continue;
			if (failure === "abort") controller.abort();
			else if (failure === "read error") source!.error(new Error("read failed"));
			else {
				if (failure === "malformed JSON") source!.enqueue(new TextEncoder().encode("data: not json\n\n"));
				source!.close();
			}
		}
		const result = await stream.result();
		expect(result.stopReason).toBe(failure === "abort" ? "aborted" : "error");
		expect(result.content).toEqual([
			{ type: "text", text: "received" },
			{ type: "thinking", thinking: "reasoning" },
			{ type: "toolCall", id: "call", name: "lookup", arguments: { key: "value" } },
		]);
		expect(body.locked).toBe(false);
	},
	1000,
);

const hostileFailures = [
	new Error("ordinary hook failure"),
	Object.create(null),
	JSON.parse('{"toString":null,"valueOf":null}'),
	(() => {
		const value = Object.create(null);
		value.self = value;
		return value;
	})(),
	"plain hook failure",
];
describe.each(cases.filter(({ name }) => name === "pi-messages" || name === "Mistral"))(
	"$name hostile failure terminalization",
	({ name, run, events }) => {
		it.each(["onPayload", "onResponse", "fetch"])(
			"settles rejected %s values without losing cleanup",
			async (hook) => {
				for (const failure of hostileFailures) {
					const cancel = vi.fn();
					let body: ReadableStream<Uint8Array> | undefined;
					const received: AssistantMessageEvent[] = [];
					const stream = run({
						...options,
						onPayload: () => {
							if (hook === "onPayload") throw failure;
						},
						onResponse: async () => {
							if (hook === "onResponse") throw failure;
						},
						fetch: async () => {
							if (hook === "fetch") throw failure;
							body = new ReadableStream<Uint8Array>({ cancel });
							return new Response(body);
						},
					});
					for await (const event of stream) received.push(event);
					const result = await stream.result();
					expect(result.stopReason).toBe("error");
					expect(received.map((event) => event.type)).toEqual(["error"]);
					expect(result.errorMessage).toBeTypeOf("string");
					if (failure instanceof Error) expect(result.errorMessage).toBe(failure.message);
					if (typeof failure === "string")
						expect(result.errorMessage).toBe(name === "pi-messages" ? failure : JSON.stringify(failure));
					if (hook === "onResponse") {
						expect(cancel).toHaveBeenCalledOnce();
						expect(body?.locked).toBe(false);
					}
				}
			},
			1000,
		);

		it.each(["ordinary", "hostile"])(
			"preserves emitted content and usage after a %s body failure",
			async (kind) => {
				let source!: ReadableStreamDefaultController<Uint8Array>;
				const partialEvents =
					name === "Mistral"
						? [{ ...events[0], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]
						: events.slice(0, 3);
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						source = controller;
						controller.enqueue(encode(partialEvents));
					},
				});
				const stream = run({ ...options, fetch: async () => new Response(body) });
				let terminalCount = 0;
				for await (const event of stream) {
					if (event.type === "text_delta")
						source.error(kind === "ordinary" ? new Error("body failed") : hostileFailures[3]);
					if (event.type === "error") terminalCount++;
				}
				const result = await stream.result();
				expect(terminalCount).toBe(1);
				expect(result.stopReason).toBe("error");
				expect(result.content).toEqual([{ type: "text", text: "héllo" }]);
				expect(result.usage).toEqual(
					name === "Mistral"
						? usage
						: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
				);
				expect(result.errorMessage).toBeTypeOf("string");
				if (kind === "ordinary") expect(result.errorMessage).toBe("body failed");
				expect(body.locked).toBe(false);
			},
			1000,
		);
	},
);

it.each(["onPayload", "onResponse", "read"])(
	"OpenAI completions safely includes raw metadata after %s fails",
	async (hook) => {
		for (const [raw, diagnostic] of [
			[{ toString: 0 }, '"toString":0'],
			[hostileFailures[3], "Unserializable thrown value"],
			["gateway reason", "gateway reason"],
		] as const) {
			const failure = { error: { metadata: { raw } } };
			let source!: ReadableStreamDefaultController<Uint8Array>;
			let body: ReadableStream<Uint8Array> | undefined;
			const cancel = vi.fn();
			const stream = completions(
				model("openai-completions"),
				{ messages: [] },
				{
					...options,
					onPayload: () => {
						if (hook === "onPayload") throw failure;
					},
					onResponse: () => {
						if (hook === "onResponse") throw failure;
					},
					fetch: async () => {
						body = new ReadableStream<Uint8Array>({
							start(controller) {
								source = controller;
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({
											id: "fixture",
											choices: [{ index: 0, delta: { content: "retained" }, finish_reason: null }],
											usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
										})}\n\n`,
									),
								);
							},
							cancel,
						});
						return new Response(body, { headers: { "content-type": "text/event-stream" } });
					},
				},
			);
			let terminals = 0;
			for await (const event of stream) {
				if (event.type === "text_delta") source.error(failure);
				if (event.type === "error") terminals++;
			}
			const result = await stream.result();
			expect(terminals).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage?.split(diagnostic)).toHaveLength(2);
			if (hook === "read") {
				expect(result.content).toEqual([{ type: "text", text: "retained" }]);
				expect(result.usage).toMatchObject(usage);
			}
			if (hook === "onResponse") expect(cancel).toHaveBeenCalledOnce();
			if (body) expect(body.locked).toBe(false);
		}
	},
	1000,
);
