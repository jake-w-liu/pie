import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentOptions } from "../src/agent.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import { NodeExecutionEnv } from "../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../src/harness/session/jsonl/repo.ts";
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

function streamCalls(ids: string[], stopReason: "toolUse" | "length" = "toolUse", terminalEvent = true): StreamFn {
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
			stopReason,
			timestamp: 1,
		};
		if (terminalEvent) stream.push({ type: "done", reason: stopReason, message });
		else stream.end(message);
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

describe("tool notification failures preserve outcomes", () => {
	for (const toolExecution of ["sequential", "parallel"] as const) {
		it.each([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"message_start",
			"message_end",
		] as const)(`${toolExecution} answers every requested call after a %s failure`, async (phase) => {
			const executed: string[] = [];
			const events: AgentEvent[] = [];
			const agent = new Agent({
				initialState: {
					model,
					tools: [
						tool(async (id, _args, _signal, update) => {
							executed.push(id);
							const actual = { content: [{ type: "text" as const, text: `completed ${id}` }], details: { id } };
							update?.(actual);
							return actual;
						}),
					],
				},
				toolExecution,
				streamFn: streamCalls(["first", "second"]),
				shouldStopAfterTurn: () => true,
			});
			agent.subscribe((event) => {
				events.push(event);
				if (event.type !== phase) return;
				if ("toolCallId" in event && event.toolCallId === "first") throw new Error(`observer ${phase}`);
				if ("message" in event && event.message.role === "toolResult" && event.message.toolCallId === "first") {
					throw new Error(`observer ${phase}`);
				}
			});
			await agent.prompt(prompt);
			await agent.waitForIdle();
			const answers = agent.state.messages.filter((message) => message.role === "toolResult");
			expect(executed).toEqual(["first", "second"]);
			expect(answers.map((message) => message.toolCallId)).toEqual(["first", "second"]);
			expect(answers.map((message) => ({ content: message.content, isError: message.isError }))).toEqual([
				{ content: [{ type: "text", text: "completed first" }], isError: false },
				{ content: [{ type: "text", text: "completed second" }], isError: false },
			]);
			expect(agent.state.errorMessage).toBe(`observer ${phase}`);
			expect(agent.state.pendingToolCalls.size).toBe(0);
			expect(agent.state.isStreaming).toBe(false);
			expect(events.at(-1)?.type).toBe("agent_end");
		});
	}
});

describe("parallel sibling settlement on entry failure", () => {
	it("parallel publishes sibling toolResults before surfacing the first failure", async () => {
		const failure = new Error("sibling listener failure");
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: {
				model,
				tools: [tool(async () => result)],
			},
			toolExecution: "parallel",
			streamFn: streamCalls(["slow", "fast"]),
			shouldStopAfterTurn: () => true,
		});
		agent.subscribe(async (event) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "slow") {
				throw failure;
			}
		});
		await agent.prompt(prompt);
		await agent.waitForIdle();
		// Both successful executions must retain their actual results, including
		// the one whose completion notification failed.
		const toolResults = agent.state.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.toolCallId)).toEqual(["slow", "fast"]);
		expect(toolResults.every((message) => !message.isError)).toBe(true);
		expect(toolResults.find((message) => (message as { toolCallId: string }).toolCallId === "fast")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "done" }],
		});
		// The failure still fails the run loudly instead of a partial success.
		expect(agent.state.errorMessage).toContain("sibling listener failure");
		expect(events.at(-1)?.type).toBe("agent_end");
	});
});

describe("sequential sibling settlement on entry failure", () => {
	it("sequential pairs every tool call before surfacing a listener failure", async () => {
		const failure = new Error("sequential listener failure");
		const executed: string[] = [];
		const agent = new Agent({
			initialState: {
				model,
				tools: [
					tool(async (_args, signal) => {
						executed.push("run");
						await signal;
						return result;
					}),
				],
			},
			toolExecution: "sequential",
			streamFn: streamCalls(["first", "second"]),
			shouldStopAfterTurn: () => true,
		});
		agent.subscribe(async (event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "first") {
				throw failure;
			}
		});
		await agent.prompt(prompt);
		await agent.waitForIdle();

		const asked = agent.state.messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) =>
				(message as AssistantMessage).content.filter((block) => block.type === "toolCall").map((block) => block.id),
			);
		const answered = agent.state.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (message as { toolCallId: string }).toolCallId);
		expect(asked.length).toBeGreaterThan(0);
		expect(answered).toEqual(asked);
		// The call after the failing one still executed instead of being abandoned.
		expect(executed.length).toBe(asked.length);
		// The failure still fails the run loudly instead of a partial success.
		expect(agent.state.errorMessage).toContain("sequential listener failure");
	});

	it("pairs every tool call of a truncated assistant message before surfacing a listener failure", async () => {
		const failure = new Error("truncated listener failure");
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "cut-1", name: "test", arguments: {} },
					{ type: "toolCall", id: "cut-2", name: "test", arguments: {} },
				],
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
				stopReason: "length",
				timestamp: 1,
			};
			stream.push({ type: "done", reason: "length", message });
			return stream;
		};
		const agent = new Agent({
			initialState: { model, tools: [tool(async () => result)] },
			toolExecution: "sequential",
			streamFn,
			shouldStopAfterTurn: () => true,
		});
		agent.subscribe(async (event) => {
			if (event.type === "tool_execution_end") throw failure;
		});
		await agent.prompt(prompt);
		await agent.waitForIdle();

		const answered = agent.state.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (message as { toolCallId: string }).toolCallId);
		expect(answered).toEqual(["cut-1", "cut-2"]);
		expect(agent.state.errorMessage).toContain("truncated listener failure");
	});
});

describe("assistant completion admission barrier", () => {
	for (const toolExecution of ["sequential", "parallel"] as const) {
		for (const stopReason of ["toolUse", "length"] as const) {
			for (const route of ["agent", "loop"] as const) {
				it.each([
					{ label: "Error", failure: new Error("completion barrier rejected") },
					{ label: "null", failure: null },
					{ label: "undefined", failure: undefined },
				])(
					`${route} ${toolExecution}/${stopReason} answers requests without execution after a $label barrier failure`,
					async ({ failure }) => {
						const events: AgentEvent[] = [];
						const execute = vi.fn(async () => result);
						const beforeToolCall = vi.fn(async () => undefined);
						const afterToolCall = vi.fn(async () => undefined);
						const observer = (event: AgentEvent) => {
							events.push(event);
							if (
								event.type === "message_end" &&
								event.message.role === "assistant" &&
								event.message.content.some((block) => block.type === "toolCall")
							)
								throw failure;
							if (
								(event.type === "message_start" || event.type === "message_end") &&
								event.message.role === "toolResult"
							)
								throw new Error("secondary result observer failure");
						};
						const tools = [tool(execute)];
						const config = {
							model,
							convertToLlm,
							toolExecution,
							beforeToolCall,
							afterToolCall,
							shouldStopAfterTurn: () => true,
						} satisfies AgentLoopConfig;
						if (route === "agent") {
							const agent = new Agent({
								...config,
								initialState: { model, tools },
								streamFn: streamCalls(["first", "second"], stopReason),
							});
							agent.subscribe(observer);
							await agent.prompt(prompt);
							await agent.waitForIdle();
							expect(agent.state.errorMessage).toBe(
								failure instanceof Error ? failure.message : String(failure),
							);
							expect(
								agent.state.messages
									.filter((message) => message.role === "toolResult")
									.map((message) => message.toolCallId),
							).toEqual(["first", "second"]);
							expect(agent.state.pendingToolCalls.size).toBe(0);
							expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
							expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
							expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
							expect(events.at(-1)?.type).toBe("agent_end");
						} else {
							const outcome = await runAgentLoop(
								[prompt],
								{ systemPrompt: "", messages: [], tools },
								config,
								observer,
								undefined,
								streamCalls(["first", "second"], stopReason),
							).then(
								() => ({ ok: true as const }),
								(error: unknown) => ({ ok: false as const, error }),
							);
							expect(outcome.ok).toBe(false);
							if (outcome.ok) throw new Error("Expected original barrier rejection");
							expect(outcome.error).toBe(failure);
						}
						const answers = events.flatMap((event) =>
							event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
						);
						expect(answers.map((message) => message.toolCallId)).toEqual(["first", "second"]);
						expect(
							answers.every(
								(message) =>
									message.isError &&
									message.content.length === 1 &&
									message.content[0].type === "text" &&
									message.content[0].text.includes("not executed"),
							),
						).toBe(true);
						expect(execute).not.toHaveBeenCalled();
						expect(beforeToolCall).not.toHaveBeenCalled();
						expect(afterToolCall).not.toHaveBeenCalled();
						expect(events.some((event) => event.type.startsWith("tool_execution_"))).toBe(false);
					},
				);
			}
		}
	}

	it("answers calls when the stream resolves without a terminal event", async () => {
		const failure = new Error("completion barrier rejected");
		const events: AgentEvent[] = [];
		const execute = vi.fn(async () => result);
		const observed = runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [], tools: [tool(execute)] },
			{ model, convertToLlm },
			(event) => {
				events.push(event);
				if (event.type === "message_end" && event.message.role === "assistant") throw failure;
			},
			undefined,
			streamCalls(["first", "second"], "toolUse", false),
		);
		await expect(observed).rejects.toBe(failure);
		expect(execute).not.toHaveBeenCalled();
		expect(
			events.flatMap((event) =>
				event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
			),
		).toEqual(["first", "second"]);
	});

	it("drains a delayed secondary result observer before prompt and idle completion", async () => {
		const failure = new Error("completion barrier rejected");
		const admitted = gate();
		const release = gate();
		const events: AgentEvent[] = [];
		let idle = false;
		const execute = vi.fn(async () => result);
		const agent = new Agent({
			initialState: { model, tools: [tool(execute)] },
			streamFn: streamCalls(["first", "second"]),
		});
		agent.subscribe(async (event) => {
			events.push(event);
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((block) => block.type === "toolCall")
			)
				throw failure;
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolCallId === "second"
			) {
				admitted.resolve();
				await release.promise;
				throw new Error("secondary failure");
			}
		});
		const running = agent.prompt(prompt);
		const waiting = agent.waitForIdle().then(() => {
			idle = true;
		});
		try {
			await admitted.promise;
			await setImmediate();
			expect(idle).toBe(false);
			expect(agent.state.isStreaming).toBe(true);
			expect(events.some((event) => event.type === "agent_end")).toBe(false);
			await expect(agent.prompt("too early")).rejects.toThrow("already processing");
		} finally {
			release.resolve();
			await Promise.all([running, waiting]);
		}
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.errorMessage).toBe(failure.message);
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(events.at(-1)?.type).toBe("agent_end");
	});
});

describe("assistant terminal iterator ownership", () => {
	it.each([false, true])("keeps the completion barrier before iterator close (rejected=%s)", async (rejected) => {
		const order: string[] = [];
		const failure = new Error("barrier rejected");
		const streamFn: StreamFn = async (...args) => {
			const stream = await streamCalls(["first"])(...args);
			const iterate = stream[Symbol.asyncIterator].bind(stream);
			vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(async function* () {
				try {
					yield* { [Symbol.asyncIterator]: iterate };
				} finally {
					order.push("iterator-close");
				}
			});
			return stream;
		};
		const execute = vi.fn(async () => {
			order.push("executed");
			return result;
		});
		const running = runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [], tools: [tool(execute)] },
			{ model, convertToLlm, shouldStopAfterTurn: () => true },
			(event) => {
				if (event.type !== "message_end") return;
				if (event.message.role === "assistant") {
					order.push("barrier");
					if (rejected) throw failure;
				} else if (event.message.role === "toolResult") order.push("result");
			},
			undefined,
			streamFn,
		);
		if (rejected) {
			await expect(running).rejects.toBe(failure);
			expect(order).toEqual(["barrier", "result", "iterator-close"]);
			expect(execute).not.toHaveBeenCalled();
		} else {
			await running;
			expect(order).toEqual(["barrier", "iterator-close", "executed", "result"]);
			expect(execute).toHaveBeenCalledTimes(1);
		}
	});
});

describe("published calls before failing response iterator close", () => {
	const failures = [
		{ label: "Error", error: new Error("iterator close rejected") },
		{ label: "null", error: null },
		{ label: "undefined", error: undefined },
	];

	function closingStream(ids: string[], stopReason: "toolUse" | "length", error: unknown, order: string[]): StreamFn {
		return async (...args) => {
			const stream = await streamCalls(ids, stopReason)(...args);
			const iterate = stream[Symbol.asyncIterator].bind(stream);
			vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(() => {
				const iterator = iterate();
				return {
					next: iterator.next.bind(iterator),
					return: async () => {
						await iterator.return?.();
						order.push("iterator-close");
						throw error;
					},
				};
			});
			return stream;
		};
	}

	for (const mode of ["parallel", "sequential"] as const) {
		for (const stopReason of ["toolUse", "length"] as const) {
			it.each(failures)(
				`${mode}/${stopReason} settles accepted calls before preserving $label close failure`,
				async ({ error }) => {
					const order: string[] = [];
					const events: AgentEvent[] = [];
					const execute = vi.fn(async () => result);
					const beforeToolCall = vi.fn(async () => undefined);
					const afterToolCall = vi.fn(async () => undefined);
					const running = runAgentLoop(
						[prompt],
						{ systemPrompt: "", messages: [], tools: [tool(execute)] },
						{
							model,
							convertToLlm,
							toolExecution: mode,
							beforeToolCall,
							afterToolCall,
							shouldStopAfterTurn: () => true,
						},
						(event) => {
							events.push(event);
							if (event.type !== "message_end") return;
							if (event.message.role === "assistant") order.push("barrier");
							else if (event.message.role === "toolResult") order.push(`result:${event.message.toolCallId}`);
						},
						undefined,
						closingStream(["first", "second"], stopReason, error, order),
					);
					await expect(running).rejects.toBe(error);
					expect(order).toEqual(["barrier", "iterator-close", "result:first", "result:second"]);
					const answers = events.flatMap((event) =>
						event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
					);
					expect(answers.map((answer) => answer.toolCallId)).toEqual(["first", "second"]);
					expect(answers.every((answer) => answer.isError)).toBe(true);
					expect(answers.map((answer) => answer.content)).toEqual([
						[{ type: "text", text: expect.stringContaining("not executed") }],
						[{ type: "text", text: expect.stringContaining("not executed") }],
					]);
					expect(execute).not.toHaveBeenCalled();
					expect(beforeToolCall).not.toHaveBeenCalled();
					expect(afterToolCall).not.toHaveBeenCalled();
					expect(events.some((event) => event.type.startsWith("tool_execution_"))).toBe(false);
				},
			);
		}
	}

	it.each(failures)("does not settle a rejected barrier twice when cleanup also throws $label", async ({ error }) => {
		const order: string[] = [];
		const failure = new Error("barrier rejected before close");
		const execute = vi.fn(async () => result);
		const running = runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [], tools: [tool(execute)] },
			{ model, convertToLlm, shouldStopAfterTurn: () => true },
			(event) => {
				if (event.type !== "message_end") return;
				if (event.message.role === "assistant") {
					order.push("barrier");
					throw failure;
				}
				if (event.message.role === "toolResult") order.push(`result:${event.message.toolCallId}`);
			},
			undefined,
			closingStream(["first", "second"], "toolUse", error, order),
		);
		await expect(running).rejects.toBe(failure);
		expect(order).toEqual(["barrier", "result:first", "result:second", "iterator-close"]);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each(failures)(
		"drains a delayed rejecting result observer before reporting $label close failure and idle",
		async ({ error }) => {
			const order: string[] = [];
			const events: AgentEvent[] = [];
			const admitted = gate();
			const release = gate();
			const execute = vi.fn(async () => result);
			const beforeToolCall = vi.fn(async () => undefined);
			const afterToolCall = vi.fn(async () => undefined);
			const agent = new Agent({
				initialState: { model, tools: [tool(execute)] },
				streamFn: closingStream(["first", "second"], "toolUse", error, order),
				beforeToolCall,
				afterToolCall,
				shouldStopAfterTurn: () => true,
			});
			agent.subscribe(async (event) => {
				events.push(event);
				if (
					event.type === "message_start" &&
					event.message.role === "toolResult" &&
					event.message.toolCallId === "first"
				) {
					admitted.resolve();
					await release.promise;
					throw new Error("secondary result-start observer failure");
				}
				if (event.type === "message_end" && event.message.role === "toolResult") {
					order.push(`result:${event.message.toolCallId}`);
					if (event.message.toolCallId === "first") throw null;
				}
			});
			let idle = false;
			const running = agent.prompt(prompt);
			const waiting = agent.waitForIdle().then(() => {
				idle = true;
			});
			try {
				const reachedResult = await Promise.race([admitted.promise.then(() => true), running.then(() => false)]);
				expect(reachedResult).toBe(true);
				await setImmediate();
				expect(idle).toBe(false);
				expect(agent.state.isStreaming).toBe(true);
				expect(events.some((event) => event.type === "agent_end")).toBe(false);
				await expect(agent.prompt("too early")).rejects.toThrow("already processing");
			} finally {
				release.resolve();
				await Promise.all([running, waiting]);
			}
			expect(agent.state.errorMessage).toBe(error instanceof Error ? error.message : String(error));
			expect(
				agent.state.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
			).toEqual(["first", "second"]);
			expect(order).toEqual(["iterator-close", "result:first", "result:second"]);
			expect(execute).not.toHaveBeenCalled();
			expect(beforeToolCall).not.toHaveBeenCalled();
			expect(afterToolCall).not.toHaveBeenCalled();
			expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
			expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
			expect(events.at(-1)?.type).toBe("agent_end");
		},
	);

	it("preserves cleanup failure without inventing results for a completed message with no calls", async () => {
		const failure = new Error("close without calls");
		const events: AgentEvent[] = [];
		const running = runAgentLoop(
			[prompt],
			{ systemPrompt: "", messages: [] },
			{ model, convertToLlm, shouldStopAfterTurn: () => true },
			(event) => {
				events.push(event);
			},
			undefined,
			closingStream([], "toolUse", failure, []),
		);
		await expect(running).rejects.toBe(failure);
		expect(events.some((event) => event.type === "message_end" && event.message.role === "toolResult")).toBe(false);
	});
});

describe("canonical tool-result durable payloads", () => {
	const detailsCases = [
		{ label: "undefined", details: undefined },
		{ label: "null", details: null },
		{ label: "false", details: false },
		{ label: "zero", details: 0 },
		{ label: "empty string", details: "" },
		{ label: "object", details: { nested: true } },
	];
	const toolUsage: AssistantMessage["usage"] = {
		input: 2,
		output: 3,
		cacheRead: 4,
		cacheWrite: 5,
		totalTokens: 14,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
	};

	async function persistRun(options: AgentOptions, configure?: (agent: Agent) => void) {
		const directory = await fs.mkdtemp(join(tmpdir(), "pi-agent-result-payload-"));
		try {
			const root = join(directory, "sessions");
			const env = new NodeExecutionEnv({ cwd: directory });
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const persisted = await repo.create({ id: "result", cwd: directory });
			const metadata = await persisted.getMetadata();
			const errors: unknown[] = [];
			const events: AgentEvent[] = [];
			const agent = new Agent(options);
			agent.subscribe(async (event) => {
				events.push(event);
				if (event.type !== "message_end") return;
				try {
					await persisted.appendMessage(event.message);
				} catch (error) {
					errors.push(error);
					throw error;
				}
			});
			configure?.(agent);
			await agent.prompt(prompt);
			const verified = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
			const entries = await verified.findEntries({ order: "oldestFirst" });
			return { agent, events, errors, entries };
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}

	for (const mode of ["parallel", "sequential"] as const) {
		for (const withUsage of [false, true]) {
			it.each(detailsCases)(
				`${mode}, usage=${withUsage}: preserves $label details through strict persistence`,
				async ({ details }) => {
					const executed: AgentToolResult<unknown> = {
						content: [{ type: "text", text: "done" }],
						details,
						...(withUsage ? { usage: toolUsage } : {}),
					};
					const run = await persistRun({
						initialState: { model, tools: [tool(async () => executed)] },
						toolExecution: mode,
						streamFn: streamCalls(["first", "second"]),
						shouldStopAfterTurn: () => true,
					});
					expect(run.errors).toEqual([]);
					expect(run.agent.state.errorMessage).toBeUndefined();
					const answers = run.entries.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
					);
					expect(answers.map((answer) => answer.toolCallId)).toEqual(["first", "second"]);
					for (const answer of answers) {
						expect(answer.details).toEqual(details);
						expect(Object.hasOwn(answer, "details")).toBe(details !== undefined);
						expect(answer.usage).toEqual(withUsage ? toolUsage : undefined);
						expect(Object.hasOwn(answer, "usage")).toBe(withUsage);
					}
				},
			);
		}

		it.each(["tool-error", "truncated", "barrier-rejected", "iterator-rejected"] as const)(
			`${mode}: persists honest ordered results from %s through the canonical factory`,
			async (route) => {
				const failure = new Error(`${route} primary failure`);
				const execute = vi.fn(async () => {
					throw failure;
				});
				const beforeToolCall = vi.fn(async () => undefined);
				const afterToolCall = vi.fn(async () => undefined);
				const streamFn: StreamFn = async (...args) => {
					const stream = await streamCalls(
						["first", "second"],
						route === "truncated" ? "length" : "toolUse",
					)(...args);
					if (route === "iterator-rejected") {
						const iterate = stream[Symbol.asyncIterator].bind(stream);
						vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(() => {
							const iterator = iterate();
							return {
								next: iterator.next.bind(iterator),
								return: async () => {
									await iterator.return?.();
									throw failure;
								},
							};
						});
					}
					return stream;
				};
				const run = await persistRun(
					{
						initialState: { model, tools: [tool(execute)] },
						toolExecution: mode,
						streamFn,
						beforeToolCall,
						afterToolCall,
						shouldStopAfterTurn: () => true,
					},
					(agent) => {
						let rejected = false;
						agent.subscribe((event) => {
							if (
								!rejected &&
								route === "barrier-rejected" &&
								event.type === "message_end" &&
								event.message.role === "assistant"
							) {
								rejected = true;
								throw failure;
							}
						});
					},
				);
				expect(run.errors).toEqual([]);
				const requests = run.entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
						: [],
				);
				const answers = run.entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
				);
				expect(requests).toEqual(["first", "second"]);
				expect(answers.map((answer) => answer.toolCallId)).toEqual(requests);
				expect(answers.every((answer) => answer.isError && !Object.hasOwn(answer, "usage"))).toBe(true);
				if (route === "tool-error") expect(execute).toHaveBeenCalledTimes(2);
				else {
					expect(execute).not.toHaveBeenCalled();
					expect(beforeToolCall).not.toHaveBeenCalled();
					expect(afterToolCall).not.toHaveBeenCalled();
				}
				if (route === "barrier-rejected" || route === "iterator-rejected") {
					expect(run.agent.state.errorMessage).toBe(failure.message);
					expect(run.events.some((event) => event.type.startsWith("tool_execution_"))).toBe(false);
				}
			},
		);

		it(`${mode}: reads defined optional metadata once before strict persistence`, async () => {
			const reads: Array<{ details: number; usage: number }> = [];
			const run = await persistRun({
				initialState: {
					model,
					tools: [
						tool(async () => {
							const counts = { details: 0, usage: 0 };
							reads.push(counts);
							return {
								content: [],
								get details() {
									return ++counts.details === 1 ? { defined: true } : undefined;
								},
								get usage() {
									return ++counts.usage === 1 ? toolUsage : undefined;
								},
							};
						}),
					],
				},
				toolExecution: mode,
				streamFn: streamCalls(["first", "second"]),
				shouldStopAfterTurn: () => true,
			});
			expect(run.errors).toEqual([]);
			expect(reads).toEqual([
				{ details: 1, usage: 1 },
				{ details: 1, usage: 1 },
			]);
			const answers = run.entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
			);
			expect(answers.map((answer) => ({ details: answer.details, usage: answer.usage }))).toEqual([
				{ details: { defined: true }, usage: toolUsage },
				{ details: { defined: true }, usage: toolUsage },
			]);
		});

		it(`${mode}: still rejects nested undefined instead of recursively cleaning details`, async () => {
			const run = await persistRun({
				initialState: { model, tools: [tool(async () => ({ content: [], details: { nested: undefined } }))] },
				toolExecution: mode,
				streamFn: streamCalls(["first", "second"]),
				shouldStopAfterTurn: () => true,
			});
			expect(run.errors).toHaveLength(2);
			expect(run.errors).toMatchObject([{ code: "invalid_payload" }, { code: "invalid_payload" }]);
			expect(run.agent.state.errorMessage).toContain("contains undefined");
			expect(run.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(
				false,
			);
		});
	}
});
