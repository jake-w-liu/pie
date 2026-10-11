import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Context, Message, Model, Tool } from "../src/types.ts";

const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: {
		messages?: Array<{ role: string; content: unknown }>;
		thinking?: { type?: string; block_binding?: { prefix_mismatch_behavior?: string } };
	};
}

function createModel(
	baseUrl: string,
	overrides: Partial<Model<"anthropic-messages">> & { compat?: Model<"anthropic-messages">["compat"] } = {},
): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true },
		...overrides,
	} as Model<"anthropic-messages">;
}

const userMessage: Message = { role: "user", content: "hi", timestamp: 1 };

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

const signedThinking = assistantMessage([
	{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-abc" },
	{ type: "text", text: "answer" },
]);

const signedThinkingWithToolCall = assistantMessage([
	{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-abc" },
	{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } },
]);

const signedThinkingOnly = assistantMessage([
	{ type: "thinking", thinking: "reasoning only", thinkingSignature: "sig-abc" },
]);

const redactedThinking = assistantMessage([
	{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-payload", redacted: true },
	{ type: "text", text: "answer" },
]);

async function readRequestBody(request: IncomingMessage): Promise<CapturedRequest["body"]> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest["body"];
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	);
}

const INVALID_SIGNATURE_BODY = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. Content before this block differs from when it was created, first at `messages.7.content.0`.',
	},
};

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

interface RunOptions {
	model?: Partial<Model<"anthropic-messages">> & { compat?: Model<"anthropic-messages">["compat"] };
	messages: Message[];
	tools?: Tool[];
	/** Requests to answer with the invalid-signature 400 before falling back to an empty stream. */
	staleSignatureRejections?: number;
	/** Overrides the default invalid-signature 400 used for counted rejections. */
	rejectionStatus?: number;
	rejectionBody?: unknown;
	thinkingEnabled?: boolean;
}

async function run(options: RunOptions): Promise<{ requests: CapturedRequest[]; result: AssistantMessage }> {
	const requests: CapturedRequest[] = [];
	let remainingRejections = options.staleSignatureRejections ?? 0;

	const server = createServer(async (request, response) => {
		requests.push({ headers: request.headers, body: await readRequestBody(request) });
		if (remainingRejections > 0) {
			remainingRejections--;
			response.writeHead(options.rejectionStatus ?? 400, { "content-type": "application/json" });
			response.end(JSON.stringify(options.rejectionBody ?? INVALID_SIGNATURE_BODY));
			return;
		}
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(
			createModel(`http://127.0.0.1:${address.port}`, options.model),
			{
				messages: options.messages,
				...(options.tools?.length ? { tools: options.tools } : {}),
			} as Context,
			{
				apiKey: "test-key",
				cacheRetention: "none",
				...(options.thinkingEnabled === undefined ? {} : { thinkingEnabled: options.thinkingEnabled }),
			},
		);
		let result: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "error") result = event.error;
			if (event.type === "done") result = event.message;
			if (event.type === "error" || event.type === "done") break;
		}
		if (!result) throw new Error("Anthropic stream produced no terminal event");
		return { requests, result };
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

function blocksOf(body: CapturedRequest["body"], index: number): ContentBlockParam[] {
	const message = body.messages?.[index];
	if (!message || !Array.isArray(message.content)) throw new Error(`Expected array content at messages.${index}`);
	return message.content as ContentBlockParam[];
}

describe("Anthropic thinking binding controls", () => {
	it("asks the API to drop prefix-mismatched thinking blocks and enables its beta", async () => {
		const { requests } = await run({ messages: [userMessage], thinkingEnabled: true });

		expect(requests).toHaveLength(1);
		expect(requests[0]!.body.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
		expect(String(requests[0]!.headers["anthropic-beta"])).toContain(THINKING_BINDING_BETA);
	});

	it("keeps the beta on budget-based thinking requests", async () => {
		const { requests } = await run({
			model: { id: "claude-sonnet-4-5", compat: {} },
			messages: [userMessage],
			thinkingEnabled: true,
		});

		expect(requests[0]!.body.thinking?.type).toBe("enabled");
		expect(requests[0]!.body.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
		expect(String(requests[0]!.headers["anthropic-beta"])).toContain(THINKING_BINDING_BETA);
	});

	it("omits the binding control when thinking is disabled", async () => {
		const { requests } = await run({ messages: [userMessage], thinkingEnabled: false });

		expect(requests[0]!.body.thinking?.block_binding).toBeUndefined();
		expect(String(requests[0]!.headers["anthropic-beta"] ?? "")).not.toContain(THINKING_BINDING_BETA);
	});

	it("omits the binding control for third-party Anthropic-compatible endpoints", async () => {
		const { requests } = await run({
			model: { provider: "third-party" },
			messages: [userMessage],
			thinkingEnabled: true,
		});

		expect(requests[0]!.body.thinking?.block_binding).toBeUndefined();
		expect(String(requests[0]!.headers["anthropic-beta"] ?? "")).not.toContain(THINKING_BINDING_BETA);
	});

	it("still sends the other betas the request shape selects", async () => {
		const { requests } = await run({
			model: { compat: { forceAdaptiveThinking: true, supportsEagerToolInputStreaming: false } },
			messages: [userMessage],
			tools: [tool],
			thinkingEnabled: true,
		});

		const beta = String(requests[0]!.headers["anthropic-beta"]);
		expect(beta).toContain("fine-grained-tool-streaming-2025-05-14");
		expect(beta).toContain(THINKING_BINDING_BETA);
		expect(beta).not.toContain("interleaved-thinking-2025-05-14");
	});
});

describe("Anthropic stale thinking signature recovery", () => {
	it("replays the turn without the rejected signed blocks", async () => {
		const { requests, result } = await run({
			messages: [userMessage, signedThinking],
			staleSignatureRejections: 1,
			thinkingEnabled: true,
		});

		expect(requests).toHaveLength(2);
		const retried = blocksOf(requests[1]!.body, 1);
		expect(retried.some((block) => block.type === "thinking")).toBe(false);
		expect(retried).toEqual([{ type: "text", text: "answer" }]);
		expect(result.stopReason).not.toBe("error");
	});

	it("keeps tool calls and user text while dropping the signed blocks", async () => {
		const { requests } = await run({
			messages: [userMessage, signedThinkingWithToolCall],
			staleSignatureRejections: 1,
			thinkingEnabled: true,
		});

		// The orphaned tool_use keeps its synthetic tool_result the first request already sent.
		expect(requests[1]!.body.messages).toHaveLength(3);
		expect(blocksOf(requests[1]!.body, 1)).toEqual([
			{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
		]);
		expect(blocksOf(requests[1]!.body, 2)).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_1" }),
		]);
	});

	it("removes an assistant message left with no content", async () => {
		const { requests } = await run({
			messages: [userMessage, signedThinkingOnly, { role: "user", content: "next", timestamp: 3 }],
			staleSignatureRejections: 1,
			thinkingEnabled: true,
		});

		expect(requests[1]!.body.messages).toHaveLength(2);
		expect(requests[1]!.body.messages?.[1]?.content).toBe("next");
	});

	it("drops opaque redacted thinking blocks", async () => {
		const { requests } = await run({
			messages: [userMessage, redactedThinking],
			staleSignatureRejections: 1,
			thinkingEnabled: true,
		});

		expect(blocksOf(requests[1]!.body, 1)).toEqual([{ type: "text", text: "answer" }]);
	});

	it("leaves unsigned thinking blocks alone", async () => {
		const unsigned = assistantMessage([{ type: "thinking", thinking: "no signature" }]);
		const { requests } = await run({
			messages: [userMessage, unsigned],
			staleSignatureRejections: 1,
			thinkingEnabled: true,
		});

		// convertMessages already sent the unsigned block as text, so there is nothing to repair
		// and the original error stands.
		expect(requests).toHaveLength(1);
	});

	it("does not retry unrelated 400s", async () => {
		const { requests, result } = await run({
			messages: [userMessage, signedThinking],
			staleSignatureRejections: 1,
			rejectionBody: {
				type: "error",
				error: { type: "invalid_request_error", message: "messages.0: text is too long" },
			},
			thinkingEnabled: true,
		});

		expect(requests).toHaveLength(1);
		expect(result.stopReason).toBe("error");
	});

	it("replays the repaired request with the same tools and thinking config", async () => {
		const { requests } = await run({
			messages: [userMessage, signedThinking],
			staleSignatureRejections: 1,
			thinkingEnabled: true,
		});

		// The retry only rewrites history, so the repaired request differs from the failed one
		// in exactly the stale blocks.
		expect(requests[0]!.body.messages?.length).toBe(requests[1]!.body.messages?.length);
		expect(JSON.stringify(requests[0]!.body.thinking)).toBe(JSON.stringify(requests[1]!.body.thinking));
	});
});

describe("Anthropic stale thinking signature classification", () => {
	it("ignores the signature error for other statuses", async () => {
		let requests = 0;
		const server = createServer(async (request, response) => {
			requests++;
			for await (const _chunk of request) {
				// drain
			}
			response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
			response.end(JSON.stringify(INVALID_SIGNATURE_BODY));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		try {
			const stream = streamAnthropic(
				createModel(`http://127.0.0.1:${address.port}`),
				{ messages: [userMessage, signedThinking] } as Context,
				{ apiKey: "test-key", cacheRetention: "none", thinkingEnabled: true, maxRetries: 0 },
			);
			for await (const event of stream) {
				if (event.type === "error" || event.type === "done") break;
			}
			// A 429 is retried by the provider layer, never repaired by signature stripping.
			expect(requests).toBe(1);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
