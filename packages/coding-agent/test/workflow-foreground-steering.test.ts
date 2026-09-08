import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	steerAcksDir,
	stepSteerInboxDir,
	writeSteerAck,
	writeSteerCapability,
} from "../../pi-subagents/src/runs/background/control-channel.ts";
import {
	resolveWorkflowForegroundSteeringTarget,
	steerWorkflowForegroundTarget,
	workflowForegroundSteeringLaunchOptions,
} from "../../pi-subagents/src/runs/foreground/workflow-foreground-steering.ts";
import type { ForegroundRunControl, SubagentState } from "../../pi-subagents/src/shared/types.ts";

const workflowRunId = "owned-workflow";
const childRunId = "owned-child";
const sessionId = "active-parent-session";

let root: string;
let state: SubagentState;
let control: ForegroundRunControl;

function persistWorkflow(status: string, ownerSessionId = sessionId): void {
	const asyncDir = join(root, workflowRunId);
	mkdirSync(asyncDir, { recursive: true });
	writeFileSync(
		join(asyncDir, "status.json"),
		JSON.stringify({ mode: "workflow", state: status, sessionId: ownerSessionId }),
	);
}

function resolve(runId = childRunId) {
	return resolveWorkflowForegroundSteeringTarget({
		state,
		asyncDirRoot: root,
		...(runId === workflowRunId ? { workflowRunId: runId } : { childRunId: runId }),
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pie-owned-workflow-steering-"));
	control = {
		runId: childRunId,
		parentWorkflowRunId: workflowRunId,
		workflowKey: "repair",
		workflowSteeringDir: join(root, "private-child-route"),
		sessionId,
		mode: "single",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		activeChildren: new Map([[0, { index: 0, agent: "worker", startedAt: Date.now(), updatedAt: Date.now() }]]),
	};
	state = {
		baseCwd: root,
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map([[childRunId, control]]),
		lastForegroundControlId: childRunId,
		cleanupTimers: new Map(),
		poller: null,
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
		completionSeen: new Map(),
		lastUiContext: null,
		workflowControllers: new Map(),
	};
	persistWorkflow("paused");
	workflowForegroundSteeringLaunchOptions(control, 0);
	writeSteerCapability(control.workflowSteeringDir!, {
		index: 0,
		supported: true,
		pid: process.pid,
		readyAt: Date.now(),
	});
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("workflow-owned foreground steering after native supervisor detach", () => {
	it.each([childRunId, workflowRunId])(
		"routes the still-owned live child through %s after its workflow controller exits",
		(runId) => {
			const route = resolve(runId);
			expect(route.ok).toBe(true);
			if (route.ok) expect(route.target.control).toBe(control);
		},
	);

	it("delivers to the existing child channel and consumes its acknowledgement without restarting it", async () => {
		const route = resolve();
		expect(route.ok).toBe(true);
		if (!route.ok) throw new Error("Owned detached child must remain steerable");
		const delivery = steerWorkflowForegroundTarget({
			target: route.target,
			message: "Continue owned work",
			mode: "steer",
		});
		const inboxDir = stepSteerInboxDir(control.workflowSteeringDir!, 0);
		const requests = readdirSync(inboxDir);
		expect(requests).toHaveLength(1);
		const requestPath = join(inboxDir, requests[0]!);
		const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
			id: string;
			message: string;
			targetIndex: number;
		};
		expect(request).toMatchObject({ message: "Continue owned work", targetIndex: 0 });
		rmSync(requestPath);
		writeSteerAck(control.workflowSteeringDir!, {
			requestId: request.id,
			index: 0,
			ts: Date.now(),
			state: "delivered",
			message: "Steering delivered to the existing session",
		});
		const result = await delivery;
		expect(result.isError).not.toBe(true);
		expect(JSON.stringify(result.content)).toContain("delivered");
		expect(readdirSync(steerAcksDir(control.workflowSteeringDir!, 0))).toEqual([]);
		expect(state.foregroundControls.get(childRunId)).toBe(control);
		expect(state.workflowControllers?.size).toBe(0);
	});

	it.each(["queued", "running"])("still requires the live scheduling controller for a %s workflow", (status) => {
		persistWorkflow(status);
		expect(resolve().ok).toBe(false);
		state.workflowControllers?.set(workflowRunId, new AbortController());
		expect(resolve().ok).toBe(true);
	});

	it.each(["complete", "failed", "stopped"])("rejects a %s workflow even if a child entry remains", (status) => {
		persistWorkflow(status);
		state.workflowControllers?.set(workflowRunId, new AbortController());
		expect(resolve().ok).toBe(false);
	});

	it("does not infer authority from a paused workflow record without an owned active child", () => {
		control.activeChildren?.clear();
		expect(resolve().ok).toBe(false);
		expect(resolve(workflowRunId).ok).toBe(false);
		state.foregroundControls.clear();
		expect(resolve().ok).toBe(false);
		expect(resolve(workflowRunId).ok).toBe(false);
	});

	it("rejects a missing or foreign parent-session binding", () => {
		persistWorkflow("paused", "other-session");
		expect(resolve().ok).toBe(false);
		persistWorkflow("paused");
		control.sessionId = "other-session";
		expect(resolve().ok).toBe(false);
		control.sessionId = sessionId;
		state.currentSessionId = null;
		expect(resolve().ok).toBe(false);
	});

	it("rejects unknown workflow ownership and ambiguous workflow-child selection", () => {
		control.parentWorkflowRunId = "different-workflow";
		expect(resolve().ok).toBe(false);
		control.parentWorkflowRunId = workflowRunId;
		state.foregroundControls.set("second-child", { ...control, runId: "second-child", workflowKey: "other" });
		expect(resolve(workflowRunId).ok).toBe(false);
		expect(resolve(childRunId).ok).toBe(true);
	});

	it("retains capability and active-index enforcement for a detached child", async () => {
		const route = resolve();
		expect(route.ok).toBe(true);
		if (!route.ok) throw new Error("Owned detached child must remain steerable");
		const inactive = await steerWorkflowForegroundTarget({ target: route.target, message: "Continue", index: 3 });
		expect(inactive.isError).toBe(true);
		writeSteerCapability(control.workflowSteeringDir!, {
			index: 0,
			supported: false,
			pid: process.pid,
			readyAt: Date.now(),
		});
		const unsupported = await steerWorkflowForegroundTarget({ target: route.target, message: "Continue" });
		expect(unsupported.isError).toBe(true);
		expect(readdirSync(stepSteerInboxDir(control.workflowSteeringDir!, 0))).toEqual([]);
	});
});
