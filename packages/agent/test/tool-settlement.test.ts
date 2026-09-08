import { setImmediate } from "node:timers/promises";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, AgentToolResult, StreamFn } from "../src/types.ts";

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
const result: AgentToolResult<unknown> = { content: [{ type: "text", text: "done" }], details: { original: true } };
const prompt: AgentMessage = { role: "user", content: "run tools", timestamp: 1 };
const parameters = Type.Object({});

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function streamCalls(ids: string[]): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: ids.map((id) => ({ type: "toolCall", id, name: "test", arguments: {} })),
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

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

function tool(execute: AgentTool<typeof parameters, unknown>["execute"]): AgentTool<typeof parameters, unknown> {
	return { name: "test", label: "test", description: "test", parameters, execute };
}

describe("tool settlement", () => {
	it.each(["sequential", "parallel"] as const)(
		"%s drains admitted updates after a non-Error tool rejection",
		async (toolExecution) => {
			const admitted = gate();
			const release = gate();
			const events: AgentEvent[] = [];
			let idleSettled = false;
			const agent = new Agent({
				initialState: {
					model,
					tools: [
						tool(async (_id, _args, _signal, onUpdate) => {
							onUpdate?.(result);
							throw Object.create(null);
						}),
					],
				},
				toolExecution,
				streamFn: streamCalls(["hostile"]),
				shouldStopAfterTurn: () => true,
			});
			agent.subscribe(async (event) => {
				events.push(event);
				if (event.type === "tool_execution_update") {
					admitted.resolve();
					await release.promise;
				}
			});
			const running = agent.prompt(prompt);
			const idle = agent.waitForIdle().then(() => {
				idleSettled = true;
			});
			try {
				await admitted.promise;
				await setImmediate();
				expect(idleSettled).toBe(false);
				expect(agent.state.isStreaming).toBe(true);
				expect(events.some((event) => event.type === "agent_end")).toBe(false);
			} finally {
				release.resolve();
				await Promise.all([running, idle]);
			}
			expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "{}" }],
			});
			expect(events.at(-1)?.type).toBe("agent_end");
		},
	);

	it("publishes a terminal diagnostic when an update listener rejects a non-Error value", async () => {
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					tool(async (_id, _args, _signal, onUpdate) => {
						onUpdate?.(result);
						return result;
					}),
				],
			},
			streamFn: streamCalls(["listener"]),
			shouldStopAfterTurn: () => true,
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "tool_execution_update") throw Object.create(null);
		});
		await expect(agent.prompt(prompt)).resolves.toBeUndefined();
		await agent.waitForIdle();
		expect(agent.state.errorMessage).toBe("{}");
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it.each(["prepare", "execute", "finalize"] as const)("normalizes non-Error failures in %s", async (phase) => {
		const messages = await runAgentLoop(
			[prompt],
			{
				systemPrompt: "",
				messages: [],
				tools: [
					tool(async () => {
						if (phase === "execute") throw Object.create(null);
						return result;
					}),
				],
			},
			{
				model,
				convertToLlm,
				shouldStopAfterTurn: () => true,
				beforeToolCall: async () => {
					if (phase === "prepare") throw Object.create(null);
					return undefined;
				},
				afterToolCall: async () => {
					if (phase === "finalize") throw Object.create(null);
					return undefined;
				},
			},
			() => {},
			undefined,
			streamCalls([phase]),
		);
		expect(messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "{}" }],
		});
	});

	it.each(["execute", "finalize"] as const)(
		"keeps Agent active after a listener fails until sibling %s settles",
		async (phase) => {
			const admitted = gate();
			const failed = gate();
			const release = gate();
			const failure = new Error("first listener failure");
			const events: { event: AgentEvent; signal: AbortSignal }[] = [];
			let promptSettled = false;
			let idleSettled = false;
			const agent = new Agent({
				initialState: {
					model,
					tools: [
						tool(async (id, _args, _signal, onUpdate) => {
							if (id === "slow" && phase === "execute") {
								admitted.resolve();
								await release.promise;
								onUpdate?.(result);
							}
							return result;
						}),
					],
				},
				streamFn: streamCalls(["slow", "fast"]),
				shouldStopAfterTurn: () => true,
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "slow" && phase === "finalize") {
						admitted.resolve();
						await release.promise;
					}
					return undefined;
				},
			});
			agent.subscribe((event, signal) => {
				events.push({ event, signal });
				if (event.type === "tool_execution_end") {
					if (event.toolCallId === "fast") {
						failed.resolve();
						throw failure;
					}
					throw new Error("later listener failure");
				}
			});
			const running = agent.prompt(prompt).then(() => {
				promptSettled = true;
			});
			const signal = agent.signal;
			const idle = agent.waitForIdle().then(() => {
				idleSettled = true;
			});
			try {
				await Promise.all([admitted.promise, failed.promise]);
				await setImmediate();
				expect(promptSettled).toBe(false);
				expect(idleSettled).toBe(false);
				expect(agent.state.isStreaming).toBe(true);
				expect(events.some(({ event }) => event.type === "agent_end")).toBe(false);
				await expect(agent.prompt("too early")).rejects.toThrow("already processing");
			} finally {
				release.resolve();
				await Promise.all([running, idle]);
			}
			expect(agent.state.errorMessage).toBe(failure.message);
			expect(events.at(-1)?.event.type).toBe("agent_end");
			expect(events.every((item) => item.signal === signal)).toBe(true);
			expect(agent.state.pendingToolCalls.size).toBe(0);
			const count = events.length;
			agent.streamFunction = streamCalls([]);
			await agent.prompt("next run");
			await setImmediate();
			expect(events.slice(count).some(({ event }) => event.type.startsWith("tool_execution_"))).toBe(false);
			expect(events.slice(count).every((item) => item.signal !== signal)).toBe(true);
		},
	);

	it("drains a parallel low-level batch and preserves its first failure", async () => {
		const failed = gate();
		const release = gate();
		const failure = new Error("first failure");
		const events: AgentEvent[] = [];
		let settled = false;
		const running = runAgentLoop(
			[prompt],
			{
				systemPrompt: "",
				messages: [],
				tools: [
					tool(async (id) => {
						if (id === "slow") await release.promise;
						return result;
					}),
				],
			},
			{ model, convertToLlm, shouldStopAfterTurn: () => true },
			(event) => {
				events.push(event);
				if (event.type === "tool_execution_end") {
					if (event.toolCallId === "fast") {
						failed.resolve();
						throw failure;
					}
					throw new Error("later failure");
				}
			},
			undefined,
			streamCalls(["slow", "fast"]),
		);
		const observed = running.catch((error: unknown) => {
			settled = true;
			return error;
		});
		try {
			await failed.promise;
			await setImmediate();
			expect(settled).toBe(false);
		} finally {
			release.resolve();
			await observed;
		}
		expect(await observed).toBe(failure);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(2);
	});

	it("observes failed update listeners immediately but drains the tool and other update listeners before idle", async () => {
		const updatesAdmitted = gate();
		const releaseUpdate = gate();
		const releaseTool = gate();
		const toolReturned = gate();
		const failure = new Error("update listener failure");
		let idleSettled = false;
		let updateIndex = 0;
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					tool(async (_id, _args, _signal, onUpdate) => {
						onUpdate?.(result);
						onUpdate?.(result);
						await releaseTool.promise;
						toolReturned.resolve();
						return result;
					}),
				],
			},
			streamFn: streamCalls(["updates"]),
			shouldStopAfterTurn: () => true,
		});
		agent.subscribe(async (event) => {
			if (event.type !== "tool_execution_update") return;
			if (updateIndex++ === 0) throw failure;
			updatesAdmitted.resolve();
			await releaseUpdate.promise;
		});
		const running = agent.prompt(prompt);
		const idle = agent.waitForIdle().then(() => {
			idleSettled = true;
		});
		try {
			await updatesAdmitted.promise;
			await setImmediate();
			expect(idleSettled).toBe(false);
			releaseTool.resolve();
			await toolReturned.promise;
			await setImmediate();
			expect(idleSettled).toBe(false);
		} finally {
			releaseTool.resolve();
			releaseUpdate.resolve();
			await Promise.all([running, idle]);
		}
		expect(agent.state.errorMessage).toBe(failure.message);
	});

	it.each(["agent", "loop"] as const)(
		"%s does not dispatch previously prepared calls after preflight cancellation",
		async (route) => {
			const preparing = gate();
			const release = gate();
			const controller = new AbortController();
			const executed: string[] = [];
			const finalized: string[] = [];
			const events: AgentEvent[] = [];
			const tools = [
				tool(async (id) => {
					executed.push(id);
					return result;
				}),
			];
			const config = {
				model,
				convertToLlm,
				toolExecution: "parallel",
				shouldStopAfterTurn: () => true,
				beforeToolCall: async ({ toolCall }, signal) => {
					if (toolCall.id === "second") {
						preparing.resolve();
						await release.promise;
						signal?.throwIfAborted();
					}
					return undefined;
				},
				afterToolCall: async ({ toolCall }) => {
					finalized.push(toolCall.id);
					return undefined;
				},
			} satisfies AgentLoopConfig;
			const agent = new Agent({
				...config,
				initialState: { model, tools },
				streamFn: streamCalls(["first", "second"]),
			});
			agent.subscribe((event) => {
				events.push(event);
			});
			const running =
				route === "agent"
					? agent.prompt(prompt)
					: runAgentLoop(
							[prompt],
							{ systemPrompt: "", messages: [], tools },
							config,
							(event) => {
								events.push(event);
							},
							controller.signal,
							streamCalls(["first", "second"]),
						);
			await preparing.promise;
			if (route === "agent") agent.abort();
			else controller.abort();
			release.resolve();
			await running;
			expect(executed).toEqual([]);
			expect(finalized).toEqual([]);
			const completions = events.filter((event) => event.type === "tool_execution_end");
			expect(completions.map((event) => event.toolCallId).sort()).toEqual(["first", "second"]);
			expect(completions.every((event) => event.isError)).toBe(true);
			const messages = events.flatMap((event) =>
				event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
			);
			expect(messages.map((message) => message.toolCallId)).toEqual(["first", "second"]);
			expect(messages.every((message) => message.isError)).toBe(true);
		},
	);

	it.each(["sequential", "parallel"] as const)(
		"%s still finalizes a tool that was cancelled after dispatch",
		async (toolExecution) => {
			const controller = new AbortController();
			const finalized: string[] = [];
			const messages = await runAgentLoop(
				[prompt],
				{
					systemPrompt: "",
					messages: [],
					tools: [
						tool(async () => {
							controller.abort();
							throw new Error("cancelled during execute");
						}),
					],
				},
				{
					model,
					convertToLlm,
					toolExecution,
					shouldStopAfterTurn: () => true,
					afterToolCall: async ({ toolCall }) => {
						finalized.push(toolCall.id);
						return { details: null };
					},
				},
				() => {},
				controller.signal,
				streamCalls(["started"]),
			);
			const toolResult = messages.find((message) => message.role === "toolResult");
			expect(finalized).toEqual(["started"]);
			expect(toolResult).toMatchObject({
				isError: true,
				details: null,
				content: [{ type: "text", text: "cancelled during execute" }],
			});
		},
	);

	it.each(["sequential", "parallel"] as const)(
		"%s replaces explicit null details but retains omitted/undefined fields",
		async (toolExecution) => {
			const events: AgentEvent[] = [];
			const details = new Map<string, unknown>([
				["null", null],
				["false", false],
				["zero", 0],
				["empty", ""],
			]);
			const messages = await runAgentLoop(
				[prompt],
				{ systemPrompt: "", messages: [], tools: [tool(async () => result)] },
				{
					model,
					convertToLlm,
					toolExecution,
					shouldStopAfterTurn: () => true,
					afterToolCall: async ({ toolCall }) =>
						toolCall.id === "omitted" ? {} : { details: details.get(toolCall.id) },
				},
				(event) => {
					events.push(event);
				},
				undefined,
				streamCalls(["null", "false", "zero", "empty", "omitted", "undefined"]),
			);
			expect(
				events.filter((event) => event.type === "tool_execution_end").map((event) => event.result.details),
			).toEqual([null, false, 0, "", result.details, result.details]);
			expect(messages.filter((message) => message.role === "toolResult").map((message) => message.details)).toEqual([
				null,
				false,
				0,
				"",
				result.details,
				result.details,
			]);
		},
	);
});
