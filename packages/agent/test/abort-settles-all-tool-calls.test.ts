import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

const CALL_IDS = ["a", "b", "c"];

function streamToolCalls(): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: CALL_IDS.map((id) => ({ type: "toolCall", id, name: "test", arguments: {} })),
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
			stopReason: "toolUse",
			timestamp: 1,
		};
		stream.push({ type: "done", reason: "toolUse", message });
		return stream;
	};
}

function collect(executed: string[]): AgentTool<never> {
	return {
		name: "test",
		description: "test tool",
		parameters: Type.Object({}),
		execute: async (id: string) => {
			executed.push(id);
			return { content: [{ type: "text", text: `done ${id}` }], details: {} };
		},
	} as unknown as AgentTool<never>;
}

describe("aborting a tool batch still answers every tool call", () => {
	it.each(["sequential", "parallel"] as const)(
		"%s leaves no tool call unanswered after an abort mid-batch",
		async (toolExecution) => {
			const executed: string[] = [];
			const events: AgentEvent[] = [];

			const agent = new Agent({
				initialState: { model, tools: [collect(executed)] },
				toolExecution,
				streamFn: streamToolCalls(),
				shouldStopAfterTurn: () => true,
			} as unknown as ConstructorParameters<typeof Agent>[0]);

			agent.subscribe((event) => {
				events.push(event);
				// Abort as soon as the first call is dispatched.
				if (event.type === "tool_execution_start") agent.abort();
			});

			await agent.prompt("run tools");

			const asked = new Set(CALL_IDS);
			const answered = new Set<string>();
			for (const message of agent.state.messages) {
				if (message.role !== "toolResult") continue;
				if (message.toolCallId) answered.add(message.toolCallId);
			}

			// An unanswered tool call is a protocol error for providers: the next
			// request built from this transcript is rejected.
			expect([...asked].sort()).toEqual([...answered].sort());
			// The abort still prevents dispatching the rest.
			expect(executed.length).toBeLessThan(CALL_IDS.length);
			expect(agent.state.isStreaming).toBe(false);
		},
		20_000,
	);
});
