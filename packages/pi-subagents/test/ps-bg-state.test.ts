import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireActiveAsyncCapacity, reconcileActiveAsyncCapacity } from "../src/runs/background/active-async-capacity.ts";
import { updateActiveRunIndex } from "../src/runs/background/active-run-index.ts";
import { cleanupAsyncRetention } from "../src/runs/background/async-retention.ts";
import { createAsyncJobTracker } from "../src/runs/background/async-job-tracker.ts";
import { createScheduledRunManager, scheduledRunStorePath, type ScheduleRecord } from "../src/runs/background/scheduled-runs.ts";
import { waitForSubagents } from "../src/runs/background/subagent-wait.ts";
import { updateTerminalRunIndex } from "../src/runs/background/terminal-run-index.ts";
import { createWaitSubscriptionManager } from "../src/runs/background/wait-subscriptions.ts";
import type { SubagentState } from "../src/shared/types.ts";
import { SUBAGENT_CONTROL_EVENT, type AsyncStatus, type ExtensionConfig } from "../src/shared/types.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("background state regressions", () => {
	it("preserves an unread control-event cursor when active jobs are restored", async () => {
		const base = temporaryRoot("pi-control-cursor-");
		const asyncRoot = path.join(base, "async");
		const resultsDir = path.join(base, "results");
		const sessionId = "/sessions/parent.jsonl";
		const runId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
		const asyncDir = path.join(asyncRoot, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(resultsDir, { recursive: true });
		const now = Date.now();
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId, sessionId, mode: "single", state: "running", pid: process.pid,
			startedAt: now, lastUpdate: now, currentStep: 0,
			steps: [{ agent: "worker", status: "running", startedAt: now }],
		}));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		updateActiveRunIndex(asyncDir, "running");
		const emitted: string[] = [];
		const pi = { events: { emit: (channel: string) => { emitted.push(channel); }, on: () => () => {} } };
		const state = {
			currentSessionId: sessionId, asyncJobs: new Map(), fleetJobs: new Map(), cleanupTimers: new Map(),
			foregroundControls: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
			resultFileCoalescer: { schedule: () => false, clear: () => {} }, lastForegroundControlId: null,
		} as unknown as SubagentState;
		const tracker = createAsyncJobTracker(pi as never, state, asyncRoot, { resultsDir, platform: "darwin", pollIntervalMs: 50 });
		tracker.handleStarted({ id: runId, asyncDir, sessionId, pid: process.pid, agent: "worker", mode: "single" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const event = { type: "needs_attention", runId, agent: "worker", index: 0, ts: Date.now(), from: "active", to: "needs_attention", message: "worker needs attention", reason: "idle" };
		fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.control", event, channels: ["event"] })}\n`);
		tracker.restoreActiveJobs();
		await new Promise((resolve) => setTimeout(resolve, 150));
		tracker.dispose();
		for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
		expect(emitted.filter((channel) => channel === SUBAGENT_CONTROL_EVENT)).toHaveLength(1);
	});

	it.each([
		["complete", "dead", 31 * 24 * 60 * 60 * 1000, 0],
		["stopped", "dead", 31 * 24 * 60 * 60 * 1000, 0],
		["complete", "alive", 31 * 24 * 60 * 60 * 1000, 1],
		["stopped", "unknown", 31 * 24 * 60 * 60 * 1000, 1],
		["complete", "dead", 1_000, 1],
	] as const)("reconciles %s slots with %s PID liveness and age %i", (state, liveness, age, expectedUsed) => {
		const base = temporaryRoot("pi-capacity-");
		const rootDir = path.join(base, "capacity");
		const sessionId = "/sessions/capacity.jsonl";
		const runId = "11111111-2222-4333-8444-555555555555";
		const asyncDir = path.join(base, "async", runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		let clock = 1_000_000;
		const options = { rootDir, now: () => clock, pidLiveness: () => liveness };
		acquireActiveAsyncCapacity({ sessionId, limit: 1, runId, kind: "runner", asyncDir }, options)!.markStarted("runner-instance");
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId, sessionId, mode: "single", state, pid: 12345,
			startedAt: clock, lastUpdate: clock, endedAt: clock, steps: [],
		}));
		clock += age;
		expect(reconcileActiveAsyncCapacity(sessionId, 1, options).used).toBe(expectedUsed);
	});

	it("claims a durable wait subscription before waking its session", () => {
		const subscriptionsDir = temporaryRoot("pi-wait-subscription-");
		const sessionId = "/sessions/wait.jsonl";
		const runId = "11111111-2222-4333-8444-555555555555";
		const makeState = () => ({
			currentSessionId: sessionId,
			waitSubscriptions: new Map(),
			foregroundRuns: new Map([[runId, {
				runId, sessionId, mode: "single", cwd: "/tmp", updatedAt: 1_000,
				children: [{ index: 0, agent: "worker", status: "detached" }],
			}]]),
		}) as unknown as SubagentState;
		const listeners = new Map<string, Set<() => void>>();
		const sent: string[] = [];
		const makePi = (label: string) => ({
			events: { on(channel: string, listener: () => void) { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => set.delete(listener); } },
			sendMessage() { sent.push(label); },
		});
		const firstState = makeState();
		const secondState = makeState();
		const first = createWaitSubscriptionManager(makePi("first") as never, firstState, { subscriptionsDir, now: () => 1_000, pollIntervalMs: 1_000_000 });
		const record = first.arm({ targetKind: "foreground", runId, requestedId: runId, timeoutMs: 10_000 });
		const second = createWaitSubscriptionManager(makePi("second") as never, secondState, { subscriptionsDir, now: () => 1_000, pollIntervalMs: 1_000_000 });
		second.restore();
		for (const state of [firstState, secondState]) state.foregroundRuns!.get(runId)!.children[0]!.status = "completed";
		first.reconcile();
		second.reconcile();
		first.dispose();
		second.dispose();
		expect(sent).toHaveLength(1);
		expect(fs.existsSync(path.join(subscriptionsDir, `${record.token}.json`))).toBe(false);
	});

	it("deduplicates a durable wait after post-delivery claim cleanup fails", () => {
		const root = temporaryRoot("pi-wait-redelivery-");
		const subscriptionsDir = path.join(root, "subscriptions");
		const resultsDir = path.join(root, "results");
		fs.mkdirSync(subscriptionsDir, { recursive: true });
		const sessionId = "/sessions/wait.jsonl";
		const runId = "11111111-2222-4333-8444-555555555555";
		let clock = 1_000;
		let deliveries = 0;
		const makeState = () => ({
			currentSessionId: sessionId,
			waitSubscriptions: new Map(),
			foregroundRuns: new Map([[runId, {
				runId, sessionId, mode: "single", cwd: "/tmp", updatedAt: 1_000,
				children: [{ index: 0, agent: "worker", status: "completed" }],
			}]]),
		}) as unknown as SubagentState;
		const pi = {
			events: { on: () => () => {} },
			sendMessage() {
				deliveries += 1;
				if (deliveries === 1) fs.chmodSync(subscriptionsDir, 0o500);
			},
		};
		const firstState = makeState();
		firstState.foregroundRuns!.get(runId)!.children[0]!.status = "detached";
		const first = createWaitSubscriptionManager(pi as never, firstState, { subscriptionsDir, resultsDir, now: () => clock, pollIntervalMs: 1_000_000 });
		first.arm({ targetKind: "foreground", runId, requestedId: runId, timeoutMs: 1_000_000 });
		firstState.foregroundRuns!.get(runId)!.children[0]!.status = "completed";
		first.reconcile();
		fs.chmodSync(subscriptionsDir, 0o700);
		first.dispose();
		expect(deliveries).toBe(1);
		expect(fs.readdirSync(subscriptionsDir).some((file) => file.includes(".claim-"))).toBe(true);

		clock += 5 * 60_000 + 1;
		const second = createWaitSubscriptionManager(pi as never, makeState(), { subscriptionsDir, resultsDir, now: () => clock, pollIntervalMs: 1_000_000 });
		second.restore();
		second.dispose();
		expect(deliveries).toBe(1);
		expect(fs.readdirSync(subscriptionsDir)).toEqual([]);
	});

	it("delivers a re-armed stale claim when no delivery replay exists", () => {
		const root = temporaryRoot("pi-wait-crash-window-");
		const subscriptionsDir = path.join(root, "subscriptions");
		const resultsDir = path.join(root, "results");
		fs.mkdirSync(subscriptionsDir, { recursive: true });
		const sessionId = "/sessions/wait.jsonl";
		const runId = "11111111-2222-4333-8444-555555555555";
		let clock = 1_000;
		let deliveries = 0;
		const makeState = (status: "detached" | "completed") => ({
			currentSessionId: sessionId,
			waitSubscriptions: new Map(),
			foregroundRuns: new Map([[runId, {
				runId, sessionId, mode: "single", cwd: "/tmp", updatedAt: 1_000,
				children: [{ index: 0, agent: "worker", status }],
			}]]),
		}) as unknown as SubagentState;
		const pi = { events: { on: () => () => {} }, sendMessage() { deliveries += 1; } };
		const first = createWaitSubscriptionManager(pi as never, makeState("detached"), { subscriptionsDir, resultsDir, now: () => clock, pollIntervalMs: 1_000_000 });
		const record = first.arm({ targetKind: "foreground", runId, requestedId: runId, timeoutMs: 1_000_000 });
		first.dispose();
		const canonicalPath = path.join(subscriptionsDir, `${record.token}.json`);
		const staleClaimPath = path.join(subscriptionsDir, `${record.token}.claim-${clock}-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json`);
		fs.renameSync(canonicalPath, staleClaimPath);

		clock += 5 * 60_000 + 1;
		const second = createWaitSubscriptionManager(pi as never, makeState("completed"), { subscriptionsDir, resultsDir, now: () => clock, pollIntervalMs: 1_000_000 });
		second.restore();
		second.dispose();
		expect(deliveries).toBe(1);
		expect(fs.readdirSync(subscriptionsDir)).toEqual([]);
	});

	it("does not sleep past the requested wait deadline", async () => {
		let clock = 0;
		const sleeps: number[] = [];
		await waitForSubagents({ timeoutMs: 100 }, undefined, {
			state: { currentSessionId: "session", asyncJobs: new Map(), foregroundControls: new Map(), cleanupTimers: new Map(), completionSeen: new Map() } as unknown as SubagentState,
			now: () => clock,
			pollIntervalMs: 1_000,
			sleep: async (ms) => { sleeps.push(ms); clock += ms; },
			backgroundWork: {
				snapshot: () => ({ providers: ["fixture"], items: [{ provider: "fixture", sessionId: "session", id: "job", label: "job", startedAt: 0 }] }),
				wakeChannels: () => [],
			},
		});
		expect(sleeps).toEqual([100]);
		expect(clock).toBe(100);

		clock = 0;
		sleeps.length = 0;
		const runId = "11111111-2222-4333-8444-555555555555";
		await waitForSubagents({ id: runId, timeoutMs: 100 }, undefined, {
			state: {
				currentSessionId: "session", asyncJobs: new Map(), foregroundControls: new Map(), cleanupTimers: new Map(), completionSeen: new Map(),
				foregroundRuns: new Map([[runId, { runId, sessionId: "session", mode: "single", cwd: "/tmp", updatedAt: 0, children: [{ index: 0, agent: "worker", status: "detached" }] }]]),
			} as unknown as SubagentState,
			now: () => clock,
			pollIntervalMs: 1_000,
			sleep: async (ms) => { sleeps.push(ms); clock += ms; },
		});
		expect(sleeps).toEqual([100]);
		expect(clock).toBe(100);
	});

	it("bounds a schedule event journal and retains its newest events", async () => {
		const base = temporaryRoot("pi-schedule-events-");
		const cwd = path.join(base, "project");
		const storeRoot = path.join(base, "store");
		fs.mkdirSync(cwd);
		const scheduleDir = path.join(scheduledRunStorePath(cwd, undefined, storeRoot), "probe");
		fs.mkdirSync(scheduleDir, { recursive: true });
		const record: ScheduleRecord = {
			schemaVersion: 1, id: "probe", name: "probe", cwd,
			trigger: { kind: "once", at: new Date(2_000).toISOString(), nextRunAt: new Date(2_000).toISOString() },
			target: { workflowScript: "return 1;" }, overlap: "skip", catchUp: "latest", paused: false,
			createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
		};
		fs.writeFileSync(path.join(scheduleDir, "schedule.json"), JSON.stringify(record));
		const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined } } as unknown as ExtensionContext;
		const manager = createScheduledRunManager({ config: {} as ExtensionConfig, storeRoot, launch: vi.fn() as never, timers: { setTimeout: (() => 0) as never, clearTimeout: () => {} } });
		for (let index = 0; index < 105; index += 1) {
			const action = index % 2 === 0 ? "schedule.pause" : "schedule.resume";
			await manager.handleToolCall({ action, id: "probe" }, ctx);
		}
		manager.stop();
		const events = fs.readFileSync(path.join(scheduleDir, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { event: string });
		expect(events).toHaveLength(100);
		expect(events.at(-1)?.event).toBe("schedule.paused");
		expect(events[0]?.event).toBe("schedule.resumed");
	});

	it("removes a terminal index marker when retention deletes its run", async () => {
		const base = temporaryRoot("pi-terminal-retention-");
		const asyncDirRoot = path.join(base, "async");
		const resultsDir = path.join(base, "results");
		const runId = "0198e6a1-1111-7000-8000-000000000000";
		const runDir = path.join(asyncDirRoot, runId);
		fs.mkdirSync(runDir, { recursive: true });
		fs.mkdirSync(resultsDir, { recursive: true });
		const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
		const status = { runId, sessionId: "session", state: "complete", mode: "single", startedAt: old, endedAt: old, lastUpdate: old, steps: [] } as AsyncStatus;
		const statusPath = path.join(runDir, "status.json");
		fs.writeFileSync(statusPath, JSON.stringify(status));
		updateTerminalRunIndex(runDir, status);
		fs.utimesSync(runDir, old / 1_000, old / 1_000);
		fs.utimesSync(statusPath, old / 1_000, old / 1_000);
		const markerRoot = path.join(asyncDirRoot, ".terminal-runs");
		expect(fs.readdirSync(path.join(markerRoot, fs.readdirSync(markerRoot)[0]!))).toHaveLength(1);
		const result = await cleanupAsyncRetention({ asyncDirRoot, resultsDir, now: () => Date.now() });
		expect(result.deletedRuns).toBe(1);
		expect(fs.readdirSync(path.join(markerRoot, fs.readdirSync(markerRoot)[0]!))).toHaveLength(0);
	});
});
