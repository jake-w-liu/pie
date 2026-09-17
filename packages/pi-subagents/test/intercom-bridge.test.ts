import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents/agents.ts";
import { applyIntercomBridgeToAgent, type IntercomBridgeState } from "../src/intercom/intercom-bridge.ts";
import { resolvePiLaunchToolPlan } from "../src/runs/shared/pi-args.ts";

function activeBridge(): IntercomBridgeState {
	return {
		active: true,
		mode: "always",
		resultDelivery: true,
		orchestratorTarget: "parent-session",
		extensionDir: "native:pi-subagents-supervisor-channel",
		instruction: "Intercom orchestration channel:\nUse contact_supervisor first.",
	};
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		systemPrompt: "test",
		source: "runtime",
		filePath: "test-agent.md",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		...overrides,
	};
}

describe("B14: bridged agents are always granted contact_supervisor", () => {
	it("grants the tool to agents with an empty tool list", () => {
		const result = applyIntercomBridgeToAgent(agent({ tools: [] }), activeBridge());
		expect(result.tools).toContain("contact_supervisor");
		expect(result.systemPrompt).toContain("contact_supervisor");
	});

	it("keeps the all-tools default for agents with no tool list", () => {
		const result = applyIntercomBridgeToAgent(agent({}), activeBridge());
		// `tools: undefined` means "all builtin tools". The bridge must not rewrite it
		// into a strict ["contact_supervisor"] allowlist, which would emit
		// `--tools contact_supervisor` and hide read/bash/edit from the child.
		expect(result.tools).toBeUndefined();
		expect(result.systemPrompt).toContain("contact_supervisor");
	});

	it("does not emit a contact_supervisor-only launch allowlist for a tool-less agent", () => {
		const result = applyIntercomBridgeToAgent(agent({}), activeBridge());
		const plan = resolvePiLaunchToolPlan({ tools: result.tools, cwd: process.cwd() });
		expect(plan.explicitToolAllowlist).toBe(false);
		expect(plan.effectiveToolAllowlist).not.toEqual(["contact_supervisor"]);
	});

	it("still appends for agents that already have tools, without duplicates", () => {
		const once = applyIntercomBridgeToAgent(agent({ tools: ["read"] }), activeBridge());
		expect(once.tools).toEqual(["read", "contact_supervisor"]);
		const twice = applyIntercomBridgeToAgent(once, activeBridge());
		expect(twice.tools?.filter((tool) => tool === "contact_supervisor")).toHaveLength(1);
	});

	it("leaves agents untouched when the bridge is inactive", () => {
		const input = agent({ tools: [] });
		const result = applyIntercomBridgeToAgent(input, { ...activeBridge(), active: false });
		expect(result).toBe(input);
	});
});
