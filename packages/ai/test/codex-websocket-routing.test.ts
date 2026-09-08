import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	type OpenAICodexResponsesOptions,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Codex routing fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://first.example.test/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const payload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "routing-account" } }),
).toString("base64");
const options: OpenAICodexResponsesOptions = {
	apiKey: `test.${payload}.original`,
	sessionId: "routing-session",
	transport: "websocket",
	headers: { "X-Tenant": "first" },
	env: { HTTPS_PROXY: "http://proxy-one.example.test:8080", NO_PROXY: "" },
};

const sockets: MockWebSocket[] = [];
let autoComplete = true;
class MockWebSocket extends EventTarget {
	static OPEN = 1;
	readyState = MockWebSocket.OPEN;
	url: string;
	headers: Record<string, string>;
	requests: unknown[] = [];
	constructor(url: string, init: { headers: Record<string, string> }) {
		super();
		this.url = url;
		this.headers = init.headers;
		sockets.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send(body: string): void {
		this.requests.push(JSON.parse(body));
		if (autoComplete) this.complete();
	}
	complete(): void {
		queueMicrotask(() =>
			this.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						type: "response.completed",
						response: { id: "response-id", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
					}),
				}),
			),
		);
	}
	close(): void {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}
afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	sockets.length = 0;
	autoComplete = true;
	vi.unstubAllGlobals();
});

describe("Codex WebSocket request routing", () => {
	it.each(["endpoint", "credentials", "headers", "proxy"] as const)(
		"opens a fresh connection after %s changes",
		async (change) => {
			vi.stubGlobal("WebSocket", MockWebSocket);
			expect((await stream(model, { messages: [] }, options).result()).stopReason).toBe("stop");
			const nextModel =
				change === "endpoint" ? { ...model, baseUrl: "https://second.example.test/backend-api" } : model;
			const nextOptions = {
				...options,
				...(change === "credentials" ? { apiKey: `test.${payload}.rotated` } : {}),
				...(change === "headers" ? { headers: { "X-Tenant": "second" } } : {}),
				...(change === "proxy" ? { env: { HTTPS_PROXY: "http://proxy-two.example.test:8080", NO_PROXY: "" } } : {}),
			};
			expect((await stream(nextModel, { messages: [] }, nextOptions).result()).stopReason).toBe("stop");
			expect(sockets).toHaveLength(2);
			expect(sockets[0].requests).toHaveLength(1);
			expect(sockets[0].readyState).toBe(3);
			expect(sockets[1].requests).toHaveLength(1);
			expect(sockets[1].url).toContain(new URL(nextModel.baseUrl).host);
			expect(sockets[1].headers.authorization).toBe(`Bearer ${nextOptions.apiKey}`);
			expect(sockets[1].headers["x-tenant"]).toBe(nextOptions.headers?.["X-Tenant"]);
		},
	);

	it("keeps a busy socket and its continuation isolated from a concurrent changed request", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const fetch = vi.fn(async () => {
			throw new Error("must not fall back to HTTP");
		});
		const originalOptions = { ...options, fetch, transport: "websocket-cached" } as const;
		const user = { role: "user", content: "original conversation", timestamp: 1 } as const;
		autoComplete = false;
		const first = stream(model, { messages: [user] }, originalOptions).result();
		await vi.waitFor(() => expect(sockets[0]?.requests).toHaveLength(1));
		autoComplete = true;
		const changed = await stream(
			{ ...model, baseUrl: "https://second.example.test/backend-api" },
			{ messages: [{ ...user, content: "private changed conversation" }] },
			{
				...originalOptions,
				apiKey: `test.${payload}.rotated`,
				headers: { "X-Tenant": "second" },
				env: { HTTPS_PROXY: "http://proxy-two.example.test:8080", NO_PROXY: "" },
			},
		).result();
		expect(changed.stopReason).toBe("stop");
		expect(sockets).toHaveLength(2);
		expect(sockets[0].readyState).toBe(1);
		expect(sockets[0].requests).toHaveLength(1);
		expect(sockets[1].url).toContain("second.example.test");
		expect(sockets[1].requests[0]).not.toHaveProperty("previous_response_id");
		expect(JSON.stringify(sockets[1].requests[0])).toContain("private changed conversation");
		expect(sockets[1].readyState).toBe(3);
		sockets[0].complete();
		const original = await first;
		expect(original.stopReason).toBe("stop");
		const resumed = await stream(
			model,
			{ messages: [user, original, { ...user, content: "continue original" }] },
			originalOptions,
		).result();
		expect(resumed.stopReason).toBe("stop");
		expect(sockets).toHaveLength(2);
		expect(sockets[0].requests[1]).toMatchObject({ previous_response_id: "response-id" });
		expect(JSON.stringify(sockets[0].requests)).not.toContain("private changed conversation");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reuses a connection when equivalent headers arrive with different casing/order", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const headers = { "X-Tenant": "first", "X-Route": "same" };
		expect((await stream(model, { messages: [] }, { ...options, headers }).result()).stopReason).toBe("stop");
		expect(
			(
				await stream(
					model,
					{ messages: [] },
					{
						...options,
						headers: { "x-route": "same", "x-tenant": "first" },
					},
				).result()
			).stopReason,
		).toBe("stop");
		expect(sockets).toHaveLength(1);
		expect(sockets[0].requests).toHaveLength(2);
	});
});
