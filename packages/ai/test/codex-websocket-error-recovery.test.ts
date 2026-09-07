import { afterEach, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
});

it("keeps a mid-stream WebSocket error visible and uses SSE for the next attempt", async () => {
	let socket: MockWebSocket | undefined;
	let connections = 0;
	class MockWebSocket extends EventTarget {
		static OPEN = 1;
		readyState = MockWebSocket.OPEN;

		constructor() {
			super();
			socket = this;
			connections++;
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}

		send(): void {
			queueMicrotask(() => {
				for (const event of [
					{ type: "response.output_item.added", item: { type: "message", id: "partial", content: [] } },
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: "Partial output" },
				]) {
					this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
				}
			});
		}

		close(): void {
			this.readyState = 3;
		}
	}
	vi.stubGlobal("WebSocket", MockWebSocket);
	const recoveredEvents = [
		{ type: "response.output_item.added", item: { type: "message", id: "recovered", content: [] } },
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Recovered" },
		{ type: "response.completed", response: { status: "completed" } },
	];
	const fetchMock = vi.fn(
		async () =>
			new Response(recoveredEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const model: Model<"openai-codex-responses"> = {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
	).toString("base64");
	const options = { apiKey: `test.${payload}.test`, sessionId: "mid-stream-disconnect", transport: "auto" as const };
	const first = stream(model, { messages: [] }, options);
	for await (const event of first) {
		if (event.type === "text_delta") {
			expect(socket).toBeDefined();
			socket!.dispatchEvent(new Event("error"));
		}
	}
	const failed = await first.result();
	expect(failed.stopReason).toBe("error");
	expect(failed.errorMessage).toBe("WebSocket error");
	expect(failed.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial output" }));
	expect(isRetryableAssistantError(failed)).toBe(true);
	expect(fetchMock).not.toHaveBeenCalled();
	expect(getOpenAICodexWebSocketDebugStats(options.sessionId)).toMatchObject({
		websocketFailures: 1,
		websocketFallbackActive: true,
	});

	const recovered = await stream(model, { messages: [] }, options).result();
	expect(recovered.stopReason).toBe("stop");
	expect(recovered.content).toContainEqual(expect.objectContaining({ type: "text", text: "Recovered" }));
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(connections).toBe(1);
});
