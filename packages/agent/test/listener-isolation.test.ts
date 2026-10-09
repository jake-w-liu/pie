import { setImmediate } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentEvent } from "../src/types.ts";

const TEST_MODEL = {
	id: "test-model",
	name: "test",
	api: "test-api",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as unknown as NonNullable<ConstructorParameters<typeof Agent>[0]["initialState"]>["model"];

function makeAgent(_failOn: AgentEvent["type"] | undefined, _seen: string[]): Agent {
	return new Agent({
		initialState: { model: TEST_MODEL, tools: [], systemPrompt: "" },
		// The loop fails on the first provider call, which is what drives
		// handleRunFailure's close-out sequence.
		streamFn: (() => {
			throw new Error("provider exploded");
		}) as unknown as ConstructorParameters<typeof Agent>[0]["streamFn"],
	});
}

function subscribeTwo(agent: Agent, failOn: AgentEvent["type"] | undefined, seen: string[]): void {
	agent.subscribe((event) => {
		seen.push(`first:${event.type}`);
		if (event.type === failOn) throw new Error(`listener failed on ${failOn}`);
	});
	agent.subscribe((event) => {
		seen.push(`second:${event.type}`);
	});
}

describe("listener failures do not strand the run", () => {
	it("publishes agent_end exactly once when a successful run's terminal listener rejects", async () => {
		const events: AgentEvent[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let terminalStarted = () => {};
		const entered = new Promise<void>((resolve) => {
			terminalStarted = resolve;
		});
		const agent = new Agent({
			initialState: { model: TEST_MODEL },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "success" }],
					api: "test-api",
					provider: "test",
					model: "test-model",
					stopReason: "stop",
					timestamp: 1,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
		});
		const unsubscribe = agent.subscribe(async (event) => {
			events.push(event);
			if (event.type === "agent_end") {
				terminalStarted();
				await gate;
				throw new Error("terminal observer failed");
			}
		});
		const running = agent.prompt("hello");
		let idle = false;
		const waiting = agent.waitForIdle().then(() => {
			idle = true;
		});
		try {
			await entered;
			await setImmediate();
			expect(idle).toBe(false);
			expect(agent.state.isStreaming).toBe(true);
		} finally {
			release();
			await Promise.all([running, waiting]);
		}
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(agent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(agent.state.errorMessage).toBe("terminal observer failed");
		unsubscribe();
		await agent.prompt("again");
		expect(agent.state.errorMessage).toBeUndefined();
	});
	for (const failOn of ["message_start", "message_end", "turn_end", "agent_end"] as const) {
		it(`still delivers agent_end when a listener throws on ${failOn}`, async () => {
			const seen: string[] = [];
			const agent = makeAgent(failOn, seen);
			subscribeTwo(agent, failOn, seen);

			await agent.prompt("hello");

			expect(
				seen.filter((entry) => entry === "first:agent_end" || entry === "second:agent_end").length,
			).toBeGreaterThanOrEqual(1);
			expect(agent.state.isStreaming).toBe(false);
		});
	}

	it("delivers an event to every listener even when an earlier one throws", async () => {
		const seen: string[] = [];
		const agent = makeAgent("message_end", seen);
		subscribeTwo(agent, "message_end", seen);

		await agent.prompt("hello");

		// The second listener still saw the event the first one threw on.
		expect(seen).toContain("second:message_end");
		// ...and saw the terminal event, so nothing gates on it is stranded.
		expect(seen).toContain("second:agent_end");
	});

	it("keeps the agent usable for a second run", async () => {
		const seen: string[] = [];
		const agent = makeAgent("message_end", seen);
		subscribeTwo(agent, "message_end", seen);

		await agent.prompt("first");
		expect(agent.state.isStreaming).toBe(false);
		seen.length = 0;

		await agent.prompt("second");
		expect(seen).toContain("first:agent_start");
		expect(seen).toContain("second:agent_end");
	});
});

describe("turn publication is independent from run finality", () => {
	function successfulAgent() {
		return new Agent({
			initialState: { model: TEST_MODEL },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "success" }],
					api: "test-api",
					provider: "test",
					model: "test-model",
					stopReason: "stop",
					timestamp: 1,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
		});
	}

	it.each(["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"] as const)(
		"pairs only started turns after a %s observer failure",
		async (phase) => {
			const agent = successfulAgent();
			const events: AgentEvent[] = [];
			let failed = false;
			agent.subscribe((event) => {
				events.push(event);
				if (!failed && event.type === phase) {
					failed = true;
					throw new Error(`${phase} rejected`);
				}
			});
			await agent.prompt("hello");
			await agent.waitForIdle();
			expect(failed).toBe(true);
			expect(events.filter((event) => event.type === "turn_start")).toHaveLength(phase === "agent_start" ? 0 : 1);
			expect(events.filter((event) => event.type === "turn_end")).toHaveLength(phase === "agent_start" ? 0 : 1);
			expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
			expect(events.at(-1)?.type).toBe("agent_end");
			expect(agent.state.errorMessage).toBe(`${phase} rejected`);
			expect(agent.state.isStreaming).toBe(false);
		},
	);

	it("drains a rejecting turn-end observer without duplicate closure and remains reusable", async () => {
		const agent = successfulAgent();
		const events: AgentEvent[] = [];
		let enter = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const unsubscribe = agent.subscribe(async (event) => {
			events.push(event);
			if (event.type === "turn_end") {
				enter();
				await gate;
				throw new Error("turn observer rejected");
			}
		});
		const running = agent.prompt("hello");
		let idle = false;
		const waiting = agent.waitForIdle().then(() => {
			idle = true;
		});
		try {
			await entered;
			await setImmediate();
			expect(idle).toBe(false);
			expect(agent.state.isStreaming).toBe(true);
			expect(events.some((event) => event.type === "agent_end")).toBe(false);
			await expect(agent.prompt("too early")).rejects.toThrow("already processing");
		} finally {
			release();
			await Promise.all([running, waiting]);
		}
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(agent.state.errorMessage).toBe("turn observer rejected");
		expect(agent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
		unsubscribe();
		const next: AgentEvent[] = [];
		agent.subscribe((event) => {
			next.push(event);
		});
		await agent.prompt("again");
		expect(agent.state.errorMessage).toBeUndefined();
		expect(next.filter((event) => event.type === "turn_start")).toHaveLength(1);
		expect(next.filter((event) => event.type === "turn_end")).toHaveLength(1);
		expect(next.at(-1)?.type).toBe("agent_end");
	});
});
