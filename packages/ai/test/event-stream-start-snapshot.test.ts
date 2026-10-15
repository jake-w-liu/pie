import { expect, it } from "vitest";
import { lazyStream, lazyStreamWithOAuthRetry } from "../src/api/lazy.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, TextContent } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<Api> = {
	id: "test",
	name: "Test",
	provider: "test",
	api: "test",
	baseUrl: "https://test.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

/**
 * Like a provider whose SSE chunks arrived together: push `start` with the live output, then fill that
 * same object and push the following events before any consumer has run.
 */
function providerStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	stream.push({ type: "start", partial: output });
	const block: TextContent = { type: "text", text: "" };
	output.content.push(block);
	stream.push({ type: "text_start", contentIndex: 0, partial: output });
	block.text += "reply";
	stream.push({ type: "text_delta", contentIndex: 0, delta: "reply", partial: output });
	stream.push({ type: "text_end", contentIndex: 0, content: "reply", partial: output });
	stream.push({ type: "done", reason: "stop", message: output });
	return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

it("keeps the start event's partial as it was when start was pushed", async () => {
	const events = await collect(providerStream());

	const start = events.find((event) => event.type === "start");
	expect(start?.type === "start" ? start.partial.content : undefined).toEqual([]);
	// Later events carry the provider's live partial by design.
	const delta = events.find((event) => event.type === "text_delta");
	expect(delta?.type === "text_delta" ? delta.partial.content : undefined).toEqual([{ type: "text", text: "reply" }]);
});

it("delivers an empty start through the lazy and OAuth-retry relays", async () => {
	const stream = lazyStreamWithOAuthRetry(model, async () => ({
		events: lazyStream(model, async () => providerStream()),
	}));

	const events = await collect(stream);

	const start = events.find((event) => event.type === "start");
	expect(start?.type === "start" ? start.partial.content : undefined).toEqual([]);
	expect(events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []))).toEqual(["reply"]);
	expect((await stream.result()).content).toEqual([{ type: "text", text: "reply" }]);
});
