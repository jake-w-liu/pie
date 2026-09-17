import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createMission, resolveMissionStoreLocation, updateMission } from "../src/missions/store.ts";
import type { MissionStoreLocation } from "../src/missions/types.ts";
import { createMissionWorkflowState } from "../src/missions/workflow-state.ts";

function testLocation(): MissionStoreLocation {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-test-"));
	return resolveMissionStoreLocation({
		projectRoot: root,
		config: { directory: path.join(root, "missions"), globalIndex: false },
	});
}

function runLink(runId: string, tokens = 0) {
	return {
		runId,
		mode: "single" as const,
		status: "completed",
		startedAt: new Date().toISOString(),
		...(tokens > 0 ? { usage: { tokens } } : {}),
	};
}

describe("B7: concurrent-style updates merge instead of losing data", () => {
	it("keeps runs and usage from interleaved completions", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active", goal: true, budget: { tokens: 1000 } });
		// Two sibling completions merged sequentially must both survive, with
		// totals recomputed across the union (the lock serializes the RMW).
		updateMission(location, mission.id, { addRuns: [runLink("r1", 10)] });
		const merged = updateMission(location, mission.id, { addRuns: [runLink("r2", 20)] });
		expect(merged.runs.map((run) => run.runId).sort()).toEqual(["r1", "r2"]);
		expect(merged.usage).toEqual({ tokens: 30 });
	});
});

describe("B8: terminal missions cannot be resurrected", () => {
	it("rejects terminal -> active transitions", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		updateMission(location, mission.id, { status: "completed" });
		expect(() => updateMission(location, mission.id, { status: "active" })).toThrow(/terminal status/);
	});

	it("still records late runs against a terminal mission without reviving it", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		updateMission(location, mission.id, { status: "failed" });
		const updated = updateMission(location, mission.id, { addRuns: [runLink("late", 5)] });
		expect(updated.status).toBe("failed");
		expect(updated.runs.some((run) => run.runId === "late")).toBe(true);
	});

	it("allows usage-only updates on terminal missions without changing status", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		updateMission(location, mission.id, { status: "completed" });
		const updated = updateMission(location, mission.id, { usage: { tokens: 7 } });
		expect(updated.status).toBe("completed");
	});
});

describe("B9: explicit status is honored with open decisions", () => {
	it("stores an explicit completed close instead of coercing to needs_decision", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		const withDecision = updateMission(location, mission.id, { addDecisions: [{ title: "decide" }] });
		expect(withDecision.status).toBe("needs_decision");
		const closed = updateMission(location, mission.id, { status: "completed" });
		expect(closed.status).toBe("completed");
	});

	it("applies non-status updates to a mission closed with an open decision", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		updateMission(location, mission.id, { addDecisions: [{ title: "decide" }] });
		updateMission(location, mission.id, { status: "completed" });
		const updated = updateMission(location, mission.id, { summary: "notes" });
		expect(updated.status).toBe("completed");
		expect(updated.summary).toBe("notes");
		const withRun = updateMission(location, mission.id, { addRuns: [runLink("late", 5)] });
		expect(withRun.status).toBe("completed");
	});

	it("still derives needs_decision implicitly when decisions open", () => {		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		const updated = updateMission(location, mission.id, { addDecisions: [{ title: "decide" }] });
		expect(updated.status).toBe("needs_decision");
	});

	it("returns to active once the last open decision resolves", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		const opened = updateMission(location, mission.id, { addDecisions: [{ title: "decide" }] });
		const decisionId = opened.decisions[0]!.id;
		const resolved = updateMission(location, mission.id, {
			resolveDecision: { id: decisionId, resolution: "yes" },
		});
		expect(resolved.status).toBe("active");
	});
});

describe("B13: workflow-state reads see external writers", () => {
	it("a handle observes values written by another handle", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		const reader = createMissionWorkflowState(location, mission.id);
		expect(reader.get("k")).toBeUndefined();
		const writer = createMissionWorkflowState(location, mission.id);
		writer.set("k", "v2");
		expect(reader.get("k")).toBe("v2");
	});

	it("round-trips values through set/get", () => {
		const location = testLocation();
		const mission = createMission(location, { title: "t", objective: "o", status: "active" });
		const state = createMissionWorkflowState(location, mission.id);
		state.set("step", { next: "action" });
		expect(state.get("step")).toEqual({ next: "action" });
	});
});
