/**
 * Regression tests for agent-loop lifecycle defects:
 * - an abort during `prepareNextTurn` still started another provider request;
 * - a tool that returned `undefined` failed the whole run and dropped sibling results;
 * - a stream that ended without a terminal event hung the run even after abort;
 * - `agentLoopContinue` appended to the caller's `context.messages`;
 * - a listener that threw mid-stream left the provider request running;
 * - `message_start` shared the provider's live content array, so a listener that serialized it
 *   after an await saw text that the following deltas delivered again.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoopContinue, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
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
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function finish(stream: MockAssistantStream, message: AssistantMessage): void {
	queueMicrotask(() => {
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length", message });
		}
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const okTool = (name: string): AgentTool => ({
	name,
	label: name,
	description: "",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `${name} ok` }], details: {} }),
});

function summarize(messages: AgentMessage[]): string[] {
	return messages.map((message) => {
		if (message.role === "assistant") return `assistant(${message.stopReason})`;
		if (message.role === "toolResult") return `toolResult(${message.toolCallId}${message.isError ? ",error" : ""})`;
		return message.role;
	});
}

describe("agent loop lifecycle regressions", () => {
	it("does not start another provider request when aborted during prepareNextTurn", async () => {
		const signals: boolean[] = [];
		let agentRef: Agent | undefined;
		const agent = new Agent({
			initialState: { model: createModel(), tools: [okTool("echo")] },
			prepareNextTurn: async () => {
				agentRef?.abort();
				return undefined;
			},
			streamFn: (_model, _context, options) => {
				signals.push(options?.signal?.aborted ?? false);
				const stream = new MockAssistantStream();
				finish(
					stream,
					signals.length === 1
						? createAssistantMessage([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }], "toolUse")
						: createAssistantMessage([{ type: "text", text: "unexpected" }]),
				);
				return stream;
			},
		});
		agentRef = agent;
		await agent.prompt("go");
		expect(signals).toEqual([false]);
		expect(summarize(agent.state.messages)).toEqual(["user", "assistant(toolUse)", "toolResult(t1)"]);
	});

	for (const toolExecution of ["parallel", "sequential"] as const) {
		it(`reports a tool that returns undefined as an error result (${toolExecution})`, async () => {
			const bad: AgentTool = {
				name: "bad",
				label: "bad",
				description: "",
				parameters: Type.Object({}),
				execute: (async () => undefined) as unknown as AgentTool["execute"],
			};
			let call = 0;
			const agent = new Agent({
				initialState: { model: createModel(), tools: [okTool("good"), bad] },
				toolExecution,
				streamFn: () => {
					const stream = new MockAssistantStream();
					finish(
						stream,
						call++ === 0
							? createAssistantMessage(
									[
										{ type: "toolCall", id: "t1", name: "good", arguments: {} },
										{ type: "toolCall", id: "t2", name: "bad", arguments: {} },
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]),
					);
					return stream;
				},
			});
			await agent.prompt("go");
			expect(agent.state.errorMessage).toBeUndefined();
			expect(summarize(agent.state.messages)).toEqual([
				"user",
				"assistant(toolUse)",
				"toolResult(t1)",
				"toolResult(t2,error)",
				"assistant(stop)",
			]);
		});
	}

	it("lets abort release a stream that ended without a terminal event", async () => {
		const agent = new Agent({
			initialState: { model: createModel() },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage([{ type: "text", text: "" }]) });
					stream.end();
				});
				return stream;
			},
		});
		const run = agent.prompt("hi").then(() => "settled");
		await sleep(50);
		agent.abort();
		expect(await Promise.race([run, sleep(2000).then(() => "hung")])).toBe("settled");
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("does not append to the caller's context in agentLoopContinue", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages: AgentMessage[]) => messages as Message[],
		};
		const context: AgentContext = { systemPrompt: "", messages: [createUserMessage("a")], tools: [] };
		const produced = await agentLoopContinue(context, config, undefined, () => {
			const stream = new MockAssistantStream();
			finish(stream, createAssistantMessage([{ type: "text", text: "hi" }]));
			return stream;
		}).result();
		expect(context.messages).toHaveLength(1);
		expect(summarize(produced)).toEqual(["assistant(stop)"]);
	});

	it("aborts the provider request when a listener throws mid-stream", async () => {
		let signal: AbortSignal | undefined;
		const agent = new Agent({
			initialState: { model: createModel() },
			streamFn: (_model, _context, options) => {
				signal = options?.signal;
				const stream = new MockAssistantStream();
				const partial = createAssistantMessage([{ type: "text", text: "" }]);
				stream.push({ type: "start", partial });
				const timer = setInterval(() => {
					if (options?.signal?.aborted) {
						clearInterval(timer);
						stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
						return;
					}
					stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
				}, 5);
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_update") throw new Error("listener boom");
		});
		await agent.prompt("hello");
		expect(agent.state.errorMessage).toBe("listener boom");
		expect(signal?.aborted).toBe(true);
	});

	it("emits message_start with the content as of start, not the provider's live content", async () => {
		let releaseListener = () => {};
		const listenerReleased = new Promise<void>((resolve) => {
			releaseListener = resolve;
		});
		let reportStartSeen = () => {};
		const startSeen = new Promise<void>((resolve) => {
			reportStartSeen = resolve;
		});
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages: AgentMessage[]) => messages as Message[],
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = () => {
			const stream = new MockAssistantStream();
			const output = createAssistantMessage([]);
			stream.push({ type: "start", partial: output });
			// Like a provider parsing already-buffered chunks: keep filling the same object while
			// the message_start listener is still running.
			void startSeen.then(() => {
				const block = { type: "text" as const, text: "" };
				output.content.push(block);
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				block.text += "reply";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "reply", partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: "reply", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				releaseListener();
			});
			return stream;
		};
		const serializedStarts: string[] = [];
		const deltas: string[] = [];

		await runAgentLoop(
			[createUserMessage("hi")],
			context,
			config,
			async (event) => {
				if (event.type === "message_start" && event.message.role === "assistant") {
					reportStartSeen();
					// Serialize after an await, as an async output writer does.
					await listenerReleased;
					serializedStarts.push(JSON.stringify(event.message.content));
				}
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					deltas.push(event.assistantMessageEvent.delta);
				}
			},
			undefined,
			streamFn,
		);

		expect(serializedStarts).toEqual(["[]"]);
		expect(deltas).toEqual(["reply"]);
	});
});
