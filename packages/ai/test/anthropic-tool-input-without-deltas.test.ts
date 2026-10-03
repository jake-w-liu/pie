import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-x",
	name: "claude-x",
	api: "anthropic-messages",
	provider: "test-anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

function sseResponse(events: unknown[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const event of events) {
					controller.enqueue(
						encoder.encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`),
					);
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function streamToolUse(events: unknown[]): Promise<Record<string, unknown> | undefined> {
	const stream = streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "read a file", timestamp: 1 }] },
		{ apiKey: "test", fetch: (async () => sseResponse(events)) as never, maxRetries: 0 },
	);
	let done: Record<string, unknown> | undefined;
	for await (const event of stream) {
		if (event.type === "done") done = event.message as never;
	}
	return done;
}

describe("Anthropic tool_use input delivered in content_block_start", () => {
	const start = {
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_1", name: "read", input: { path: "/etc/hosts" } },
	};
	const header = {
		type: "message_start",
		message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 1, output_tokens: 1 } },
	};
	const tail = [
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];

	it("keeps the start-block input when no input_json_delta carries it", async () => {
		// Some gateways send complete `input` in content_block_start. Re-deriving the
		// arguments from an empty streaming buffer discarded them.
		const done = await streamToolUse([header, start, ...tail]);
		const call = (done?.content as Array<{ type: string; arguments?: unknown }> | undefined)?.find(
			(c) => c.type === "toolCall",
		);
		expect(call?.arguments).toEqual({ path: "/etc/hosts" });
	});

	it("keeps the start-block input when an empty delta follows it", async () => {
		const done = await streamToolUse([
			header,
			start,
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
			...tail,
		]);
		const call = (done?.content as Array<{ type: string; arguments?: unknown }> | undefined)?.find(
			(c) => c.type === "toolCall",
		);
		expect(call?.arguments).toEqual({ path: "/etc/hosts" });
	});

	it("still prefers streamed arguments when deltas are present", async () => {
		const done = await streamToolUse([
			header,
			start,
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '"/tmp/streamed"}' },
			},
			...tail,
		]);
		const call = (done?.content as Array<{ type: string; arguments?: unknown }> | undefined)?.find(
			(c) => c.type === "toolCall",
		);
		expect(call?.arguments).toEqual({ path: "/tmp/streamed" });
	});
});
