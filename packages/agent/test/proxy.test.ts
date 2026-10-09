import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it.each(["done", "error", "malformed", "event-failure", "abort", "eof", "cancel-failure"] as const)(
		"releases the reader and abort subscription after %s",
		async (mode) => {
			const controller = new AbortController();
			const cancel = vi.fn(() => {
				if (mode === "cancel-failure") throw new Error("cleanup failed");
			});
			const body = new ReadableStream<Uint8Array>({
				start(source) {
					if (mode === "abort") return;
					if (mode === "eof") {
						source.close();
						return;
					}
					const line =
						mode === "malformed"
							? "{broken}"
							: JSON.stringify(
									mode === "event-failure"
										? { type: "text_delta", contentIndex: 0, delta: "invalid" }
										: mode === "error"
											? { type: "error", reason: "error", usage, errorMessage: "server failed" }
											: { type: "done", reason: "stop", usage },
								);
					// A terminal event must stop both later lines and future reads.
					source.enqueue(new TextEncoder().encode(`data: ${line}\n\ndata: {bad-after-terminal}\n\n`));
				},
				cancel,
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body)),
			);
			const stream = streamProxy(
				model,
				{ messages: [] },
				{
					authToken: "fixture",
					proxyUrl: "https://example.invalid",
					signal: controller.signal,
				},
			);
			if (mode === "abort") {
				await setImmediate();
				controller.abort();
			}
			const result = await stream.result();
			await setImmediate();
			expect(result.stopReason).toBe(
				mode === "done" || mode === "cancel-failure" ? "stop" : mode === "abort" ? "aborted" : "error",
			);
			if (mode === "error") expect(result.errorMessage).toBe("server failed");
			expect(body.locked).toBe(false);
			expect(cancel).toHaveBeenCalledTimes(mode === "eof" ? 0 : 1);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
		},
	);
	it("settles an actual Fetch abort with a non-Error reason", async () => {
		const controller = new AbortController();
		controller.abort(Object.create(null));
		// Already aborted: the actual runtime Fetch rejects before any connection.
		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "fixture",
				proxyUrl: "https://example.invalid",
				signal: controller.signal,
			},
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				stream.result(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("Proxy terminal event was not published")), 2000);
				}),
			]);
			expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "{}" });
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
		} finally {
			clearTimeout(timer);
		}
	});

	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	it("resolves result() with an error when the stream ends without a terminal event (regression: clean-EOF hang)", async () => {
		// Server drops the connection after content but before a done/error event.
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "hello" },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);

		// The consuming agent loop awaits result() after the event loop exits; it
		// must resolve rather than hang.
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a terminal event");
	});

	it("surfaces a missing auth token as a stream error instead of throwing", async () => {
		// streamProxy must never throw synchronously or reject without a terminal
		// event: failures belong in the returned stream.
		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Proxy auth token is required");
		expect(events.some((event) => event.type === "error")).toBe(true);
	});
});

describe("streamProxy framing robustness", () => {
	it("processes a terminal data line stranded without a trailing newline", async () => {
		const done = JSON.stringify({ type: "done", reason: "stop", usage });
		const body = `data: ${JSON.stringify({ type: "start" })}\n\n${`data: ${done}`}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("tolerates data fields without a space and CRLF line endings", async () => {
		const done = JSON.stringify({ type: "done", reason: "stop", usage });
		const body = `data:${JSON.stringify({ type: "start" })}\r\n\r\ndata:${done}\r\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("strips the partialJson staging field when the stream aborts mid-tool-call", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_abort|fc_abort", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":' },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.content[0]).toMatchObject({ type: "toolCall" });
		expect("partialJson" in (result.content[0] as unknown as Record<string, unknown>)).toBe(false);
	});

	it("does not retroactively mutate previously emitted partials", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "hello" },
			{ type: "text_delta", contentIndex: 0, delta: " world" },
			{ type: "done", reason: "stop", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const deltas = events.filter((event) => event.type === "text_delta");
		expect(deltas).toHaveLength(2);
		const first = deltas[0];
		if (first.type !== "text_delta") throw new Error("expected text_delta");
		expect(first.partial.content[0]).toMatchObject({ type: "text", text: "hello" });
		await stream.result();
	});
});

describe("proxy cancellation settlement does not own the local reader lock", () => {
	for (const cancellation of ["pending", "rejecting"] as const) {
		it.each(["done", "error", "malformed", "abort"] as const)(
			`${cancellation} cancellation releases the reader after %s`,
			async (mode) => {
				const controller = new AbortController();
				let release = () => {};
				const cancel = vi.fn(() =>
					cancellation === "pending"
						? new Promise<void>((resolve) => {
								release = resolve;
							})
						: Promise.reject(new Error("transport cancellation rejected")),
				);
				const body = new ReadableStream<Uint8Array>({
					start(source) {
						if (mode === "abort") return;
						const payload =
							mode === "malformed"
								? "{broken}"
								: JSON.stringify(
										mode === "error"
											? { type: "error", reason: "error", usage, errorMessage: "server failure" }
											: { type: "done", reason: "stop", usage },
									);
						source.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
					},
					cancel,
				});
				vi.stubGlobal(
					"fetch",
					vi.fn(async () => new Response(body)),
				);
				const stream = streamProxy(
					model,
					{ messages: [] },
					{ authToken: "fixture", proxyUrl: "https://example.invalid", signal: controller.signal },
				);
				try {
					if (mode === "abort") {
						await setImmediate();
						controller.abort();
					}
					const result = await stream.result();
					await setImmediate();
					expect(result.stopReason).toBe(mode === "done" ? "stop" : mode === "abort" ? "aborted" : "error");
					if (mode === "error") expect(result.errorMessage).toBe("server failure");
					expect(body.locked).toBe(false);
					expect(cancel).toHaveBeenCalledTimes(1);
					expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
					const events: AssistantMessageEvent[] = [];
					for await (const event of stream) events.push(event);
					expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
				} finally {
					release();
					await setImmediate();
				}
			},
		);
	}
});
