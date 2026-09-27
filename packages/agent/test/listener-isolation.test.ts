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
