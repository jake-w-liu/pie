import { afterEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	inputs: [] as unknown[],
	streamEvents: undefined as unknown[] | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		destroy(): void {}

		send(command: { input: unknown }): Promise<unknown> {
			bedrockMock.inputs.push(command.input);
			if (!bedrockMock.streamEvents) return Promise.reject(new Error("captured"));
			const events = bedrockMock.streamEvents;
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield* events;
				})(),
			});
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const bedrockModel: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
};

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
};

const mistralModel: Model<"mistral-conversations"> = {
	id: "mistral-large",
	name: "Mistral",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const userMessage = { role: "user" as const, content: "hi", timestamp: 1 };

function sse(events: unknown[]): Response {
	return new Response(
		events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function anthropicToolEvents(servedModel: string): unknown[] {
	return [
		{ type: "message_start", message: { id: "msg_1", model: servedModel, usage: { input_tokens: 10 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
		},
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
}

function toolHistory(ids: [string, string]): Context {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const prior: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: ids[0], name: "one", arguments: {} },
			{ type: "toolCall", id: ids[1], name: "two", arguments: {} },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
	return {
		messages: [
			userMessage,
			prior,
			{
				role: "toolResult",
				toolCallId: ids[0],
				toolName: "one",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: ids[1],
				toolName: "two",
				content: [{ type: "text", text: "2" }],
				isError: false,
				timestamp: 4,
			},
		],
	};
}

afterEach(() => {
	bedrockMock.inputs = [];
	bedrockMock.streamEvents = undefined;
});

describe("Bedrock stream regressions", () => {
	it("accounts for one-hour cache writes", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
			{
				metadata: {
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						totalTokens: 155,
						cacheWriteInputTokens: 140,
						cacheDetails: [
							{ ttl: "1h", inputTokens: 100 },
							{ ttl: "5m", inputTokens: 40 },
						],
					},
				},
			},
		];

		const result = await streamBedrock(
			bedrockModel,
			{ messages: [userMessage] },
			{ cacheRetention: "none" },
		).result();
		expect(result.usage.cacheWrite).toBe(140);
		expect(result.usage.cacheWrite1h).toBe(100);
		expect(result.usage.cost.cacheWrite).toBe(0.00075);
	});

	it("finalizes tool arguments when contentBlockStop is absent", async () => {
		const prefix = `{"x":"${"a".repeat(3000)}`;
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t1", name: "write" } } } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: prefix } } } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'Z"}' } } } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		const result = await streamBedrock(
			bedrockModel,
			{ messages: [userMessage] },
			{ cacheRetention: "none" },
		).result();
		const call = result.content[0];
		expect(call.type).toBe("toolCall");
		if (call.type !== "toolCall") throw new Error("Expected a tool call");
		expect(call.arguments.x).toHaveLength(3001);
		expect(call.arguments.x).toMatch(/Z$/u);
		expect(Object.keys(call)).not.toContain("parsedJsonLength");
	});

	it("replays empty signed thinking before a tool use", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed-opaque" } } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tool-1", name: "lookup" } } } },
			{ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":"x"}' } } } },
			{ contentBlockStop: { contentBlockIndex: 1 } },
			{ messageStop: { stopReason: "tool_use" } },
		];
		const first = await streamBedrock(
			bedrockModel,
			{ messages: [userMessage] },
			{ cacheRetention: "none", thinkingDisplay: "omitted" },
		).result();
		const context: Context = {
			messages: [
				userMessage,
				first,
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "lookup",
					content: [{ type: "text", text: "x" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		bedrockMock.streamEvents = undefined;
		await streamBedrock(bedrockModel, context, { cacheRetention: "none" }).result();
		const input = bedrockMock.inputs.at(-1) as { messages: Array<{ role: string; content: unknown[] }> };
		expect(input.messages[1].content[0]).toEqual({
			reasoningContent: { reasoningText: { text: "", signature: "signed-opaque" } },
		});
	});
});

describe("Anthropic regressions", () => {
	it("retains the requested model for aliases but treats configured fallback responses as cross-model", async () => {
		const alias = await streamAnthropic(
			anthropicModel,
			{ messages: [userMessage] },
			{
				apiKey: "test",
				thinkingEnabled: true,
				fetch: async () => sse(anthropicToolEvents("claude-sonnet-4-5-20250929")),
			},
		).result();
		expect(alias.model).toBe(anthropicModel.id);
		expect(alias.responseModel).toBe("claude-sonnet-4-5-20250929");
		expect(alias.crossModelResponse).toBeUndefined();

		let aliasPayload: unknown;
		await streamAnthropic(
			anthropicModel,
			{
				messages: [
					userMessage,
					alias,
					{
						role: "toolResult",
						toolCallId: "tool-1",
						toolName: "lookup",
						content: [{ type: "text", text: "x" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{
				apiKey: "test",
				thinkingEnabled: true,
				onPayload: (payload) => {
					aliasPayload = payload;
				},
				fetch: async () =>
					sse([
						{
							type: "message_start",
							message: { id: "msg_2", model: anthropicModel.id, usage: { input_tokens: 1 } },
						},
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
						{ type: "message_stop" },
					]),
			},
		).result();
		const aliasMessages = (aliasPayload as { messages: Array<{ content: Array<{ type: string }> }> }).messages;
		expect(aliasMessages[1].content[0].type).toBe("thinking");

		const fallbackId = "claude-haiku-4-5";
		const fallbackModel: Model<"anthropic-messages"> = {
			...anthropicModel,
			compat: {
				allowedFallbackModels: [{ provider: "anthropic", model: fallbackId, cost: anthropicModel.cost }],
			},
		};
		const fallback = await streamAnthropic(
			fallbackModel,
			{ messages: [userMessage] },
			{
				apiKey: "test",
				thinkingEnabled: true,
				fetch: async () => sse(anthropicToolEvents(fallbackId)),
			},
		).result();
		expect(fallback.model).toBe(fallbackModel.id);
		expect(fallback.responseModel).toBe(fallbackId);
		expect(fallback.crossModelResponse).toBe(true);

		let fallbackPayload: unknown;
		await streamAnthropic(
			fallbackModel,
			{
				messages: [
					userMessage,
					fallback,
					{
						role: "toolResult",
						toolCallId: "tool-1",
						toolName: "lookup",
						content: [{ type: "text", text: "x" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{
				apiKey: "test",
				thinkingEnabled: true,
				onPayload: (payload) => {
					fallbackPayload = payload;
				},
				fetch: async () =>
					sse([
						{
							type: "message_start",
							message: { id: "msg_3", model: fallbackModel.id, usage: { input_tokens: 1 } },
						},
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
						{ type: "message_stop" },
					]),
			},
		).result();
		const fallbackMessages = (fallbackPayload as { messages: Array<{ content: Array<{ type: string }> }> }).messages;
		expect(fallbackMessages[1].content[0].type).toBe("text");

		// The recorded verdict must survive a replay whose model object no longer lists the fallback,
		// because replaying a signature produced by another model is rejected by the API.
		const replayWithoutCompat: Model<"anthropic-messages"> = { ...fallbackModel, compat: undefined };
		let unlistedPayload: unknown;
		await streamAnthropic(
			replayWithoutCompat,
			{
				messages: [
					userMessage,
					fallback,
					{
						role: "toolResult",
						toolCallId: "tool-1",
						toolName: "lookup",
						content: [{ type: "text", text: "x" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{
				apiKey: "test",
				thinkingEnabled: true,
				onPayload: (payload) => {
					unlistedPayload = payload;
				},
				fetch: async () =>
					sse([
						{
							type: "message_start",
							message: { id: "msg_4", model: replayWithoutCompat.id, usage: { input_tokens: 1 } },
						},
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
						{ type: "message_stop" },
					]),
			},
		).result();
		const unlistedMessages = (
			unlistedPayload as { messages: Array<{ content: Array<{ type: string; signature?: string }> }> }
		).messages;
		expect(unlistedMessages[1].content[0]).toMatchObject({ type: "text" });
	});

	it("keeps colliding normalized tool IDs distinct and paired", async () => {
		let payload: unknown;
		await streamAnthropic(anthropicModel, toolHistory(["call:a", "call?a"]), {
			apiKey: "test",
			cacheRetention: "none",
			onPayload: (value) => {
				payload = value;
			},
			fetch: async () => new Response("bad", { status: 400 }),
		}).result();
		const messages = (payload as { messages: Array<{ content: Array<{ id?: string; tool_use_id?: string }> }> })
			.messages;
		const calls = messages[1].content.map((block) => block.id);
		const results = messages[2].content.map((block) => block.tool_use_id);
		expect(new Set(calls).size).toBe(2);
		expect(results).toEqual(calls);
	});
});

describe("Mistral regressions", () => {
	it("retries a retryable response when maxRetries is set", async () => {
		// Mistral is a plain fetch call, so it must opt into the shared retry helper
		// itself; before that `maxRetries` was accepted and silently ignored.
		let attempts = 0;
		const event = { id: "r1", choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] };
		const result = await streamMistral(
			mistralModel,
			{ messages: [userMessage] },
			{
				apiKey: "test",
				maxRetries: 2,
				fetch: async () => {
					attempts += 1;
					if (attempts < 3) {
						return new Response("rate limited", { status: 429, headers: { "retry-after-ms": "0" } });
					}
					return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 });
				},
			},
		).result();

		expect(attempts).toBe(3);
		expect(result.stopReason).toBe("stop");
	});

	it("does not retry by default", async () => {
		let attempts = 0;
		const result = await streamMistral(
			mistralModel,
			{ messages: [userMessage] },
			{
				apiKey: "test",
				fetch: async () => {
					attempts += 1;
					return new Response("rate limited", { status: 429 });
				},
			},
		).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("strips streaming scratch fields from terminal errors", async () => {
		const event = {
			id: "r1",
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: "abc123xyz", function: { name: "lookup", arguments: '{"q":"x"}' } }],
					},
				},
			],
		};
		const result = await streamMistral(
			mistralModel,
			{ messages: [userMessage] },
			{
				apiKey: "test",
				fetch: async () => new Response(`data: ${JSON.stringify(event)}\n\ndata: {malformed}\n\n`, { status: 200 }),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(Object.keys(result.content[0])).toEqual(["type", "id", "name", "arguments"]);
	});

	it("normalizes cross-provider tool IDs to exactly nine alphanumeric characters", async () => {
		let payload: unknown;
		await streamMistral(mistralModel, toolHistory(["foreign:2587453", "other:id"]), {
			apiKey: "test",
			fetch: async (_url, init) => {
				payload = JSON.parse(String(init?.body));
				return new Response("bad", { status: 400 });
			},
		}).result();
		const messages = (
			payload as { messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> }
		).messages;
		const calls = messages.find((message) => message.role === "assistant")!.tool_calls!.map((call) => call.id);
		const results = messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
		for (const id of [...calls, ...results]) expect(id).toMatch(/^[A-Za-z0-9]{9}$/u);
		expect(results).toEqual(calls);
	});
});

describe("Bedrock tool ID normalization", () => {
	it("keeps colliding normalized tool IDs distinct and paired", async () => {
		await streamBedrock(bedrockModel, toolHistory(["call:a", "call?a"]), { cacheRetention: "none" }).result();
		const input = bedrockMock.inputs[0] as {
			messages: Array<{ content: Array<{ toolUse?: { toolUseId: string }; toolResult?: { toolUseId: string } }> }>;
		};
		const calls = input.messages[1].content.flatMap((block) => block.toolUse?.toolUseId ?? []);
		const results = input.messages[2].content.flatMap((block) => block.toolResult?.toolUseId ?? []);
		expect(new Set(calls).size).toBe(2);
		expect(results).toEqual(calls);
	});
});
