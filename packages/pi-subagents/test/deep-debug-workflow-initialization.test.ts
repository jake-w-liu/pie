import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as capacity from "../src/runs/background/active-async-capacity.ts";
import * as activeIndex from "../src/runs/background/active-run-index.ts";
import { listAsyncRuns } from "../src/runs/background/async-status.ts";
import { resultFilePath } from "../src/runs/background/result-files.ts";
import { readRecentTerminalRunIndex } from "../src/runs/background/terminal-run-index.ts";
import { createSubagentExecutor } from "../src/runs/foreground/subagent-executor.ts";
import * as missionLifecycle from "../src/missions/lifecycle.ts";
import * as missionState from "../src/missions/workflow-state.ts";
import * as fanout from "../src/runs/shared/run-fanout-budget.ts";
import * as atomic from "../src/shared/atomic-json.ts";
import * as persistence from "../src/shared/capacity-resilient-json.ts";
import { DIRS, type AsyncStatus, type SubagentState } from "../src/shared/types.ts";
import * as workflow from "../src/workflows/scripted-workflow.ts";

const writeAtomicJson = atomic.writeAtomicJson;
const writePrivateAtomicJson = atomic.writePrivateAtomicJson;
const fanoutSnapshot = fanout.getRunFanoutBudgetSnapshot;
const acquireCapacity = capacity.acquireActiveAsyncCapacity;
const updateActiveRunIndex = activeIndex.updateActiveRunIndex;
const capacitySnapshot = capacity.getActiveAsyncCapacitySnapshot;
const createWriter = persistence.createCapacityResilientJsonWriter;
const runWorkflowScript = workflow.runWorkflowScript;
const removeFile = fs.rmSync;
const params = { workflowScript: "return 1;", async: true, mission: false, output: false };

function storageFault(code: string): Error & { code: string } {
	return Object.assign(new Error(`OFFLINE_INITIALIZATION_${code}`), { code });
}

describe("top-level async workflow initialization and capacity (source integration)", () => {
	const originalDirs = { ...DIRS };
	let originalDepth: string | undefined;
	let directory: string;
	let sessionId: string;
	let budget: ReturnType<typeof fanout.createRunFanoutBudget>;
	let state: SubagentState;
	let ctx: ExtensionContext;
	let executor: ReturnType<typeof createSubagentExecutor>;
	let runSpy: MockInstance<typeof workflow.runWorkflowScript>;
	let writers: persistence.CapacityResilientJsonWriter[];
	let releaseRunner: (() => void) | undefined;
	let capacityIdentities: Set<string>;

	function createExecutor(limit = 1) {
		return createSubagentExecutor({ pi: {} as ExtensionAPI, state, config: { artifactDir: "project", maxActiveAsyncRunsPerSession: limit }, asyncByDefault: true,
			tempArtifactsDir: join(directory, "artifacts"), getSubagentSessionRoot: () => join(directory, "sessions"), expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }) });
	}

	function createTrackedWriter(options: persistence.CapacityResilientJsonWriterOptions | undefined) {
		const writer = createWriter(options);
		vi.spyOn(writer, "dispose");
		writers.push(writer);
		return writer;
	}

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-workflow-initialization-regression-"));
		sessionId = `offline-initialization-${randomUUID()}`;
		capacityIdentities = new Set([sessionId]);
		originalDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "0";
		Object.assign(DIRS, { async: join(directory, "async"), results: join(directory, "results"), chain: join(directory, "chain"), artifacts: join(directory, "artifacts") });
		budget = fanout.createRunFanoutBudget(sessionId, 4);
		state = { baseCwd: directory, currentSessionId: sessionId, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
			cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} } };
		// A session file takes precedence over getSessionId in the actual executor.
		ctx = { cwd: directory, hasUI: false, isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null } } as unknown as ExtensionContext;
		executor = createExecutor();
		runSpy = vi.spyOn(workflow, "runWorkflowScript");
		writers = [];
		releaseRunner = undefined;
		vi.spyOn(persistence, "createCapacityResilientJsonWriter").mockImplementation(createTrackedWriter);
	});

	afterEach(async () => {
		releaseRunner?.();
		for (const controller of state.workflowControllers?.values() ?? []) controller.abort();
		// A failing pre-fix test may leave a controller without launching a Worker.
		if (runSpy.mock.calls.length === 0) state.workflowControllers?.clear();
		await vi.waitFor(() => expect(state.workflowControllers?.size ?? 0).toBe(0), { timeout: 10000 });
		for (const writer of writers) writer.dispose();
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		Object.assign(DIRS, originalDirs);
		if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = originalDepth;
		for (const identity of capacityIdentities) fs.rmSync(join(capacity.ACTIVE_ASYNC_CAPACITY_DIR, capacity.activeAsyncCapacitySessionKey(identity)), { recursive: true, force: true });
		fs.rmSync(budget.directory, { recursive: true, force: true });
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function execute(id: string) {
		return executor.execute(id, { ...params, runFanoutBudget: budget }, new AbortController().signal, undefined, ctx);
	}

	function expectNoLaunchOrOwnedState(): void {
		expect(runSpy).not.toHaveBeenCalled();
		expect(state.workflowControllers?.size ?? 0).toBe(0);
		expect(state.workflowChildStops?.size ?? 0).toBe(0);
		expect(state.asyncJobs.size).toBe(0);
		expect(state.fleetJobs?.size ?? 0).toBe(0);
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 0, limit: 1 });
		for (const writer of writers) {
			expect(writer.dispose).toHaveBeenCalledTimes(1);
			expect(writer.pendingCount()).toBe(0);
		}
	}

	async function expectNextAdmission(): Promise<void> {
		const receipt = await execute("offline-next-admission");
		expect(receipt.isError).not.toBe(true);
		expect(receipt.details.activeAsyncCapacity).toEqual({ used: 1, limit: 1 });
		const runId = receipt.details.asyncId!;
		await vi.waitFor(() => expect(state.workflowControllers?.has(runId)).toBe(false), { timeout: 10000 });
		expect(runSpy).toHaveBeenCalledTimes(1);
		const status = JSON.parse(fs.readFileSync(join(receipt.details.asyncDir!, "status.json"), "utf8")) as AsyncStatus;
		expect(status).toMatchObject({ runId, state: "complete", workflow: { value: 1 } });
		expect(JSON.parse(fs.readFileSync(resultFilePath(DIRS.results, runId), "utf8"))).toMatchObject({ state: "complete", success: true });
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 0, limit: 1 });
	}

	it.each(["EACCES", "ENOSPC"])("rolls back initial status %s without starting a Worker, then admits real work", async (code) => {
		const fault = vi.spyOn(atomic, "writeAtomicJson").mockImplementation((filePath, payload) => {
			if (filePath.startsWith(`${DIRS.async}/`) && filePath.endsWith("/status.json")) throw storageFault(code);
			writeAtomicJson(filePath, payload);
		});
		const first = await execute("offline-status-fault");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining(`OFFLINE_INITIALIZATION_${code}`) }));
		expect(writers).toHaveLength(2);
		expectNoLaunchOrOwnedState();
		fault.mockRestore();
		await expectNextAdmission();
	}, 20000);

	it("contains a fanout snapshot failure before registering live workflow state", async () => {
		vi.spyOn(fanout, "getRunFanoutBudgetSnapshot").mockImplementationOnce(() => { throw storageFault("FANOUT_SNAPSHOT"); });
		const first = await execute("offline-fanout-snapshot-fault");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_FANOUT_SNAPSHOT") }));
		expectNoLaunchOrOwnedState();
		await expectNextAdmission();
	}, 20000);

	it("contains a capacity snapshot failure before initial persistence and the started mark", async () => {
		vi.spyOn(capacity, "getActiveAsyncCapacitySnapshot").mockImplementationOnce(() => { throw storageFault("CAPACITY_SNAPSHOT"); });
		const statusWrites = vi.spyOn(atomic, "writeAtomicJson");
		const first = await execute("offline-capacity-snapshot-fault");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_CAPACITY_SNAPSHOT") }));
		expect(statusWrites.mock.calls.some(([filePath]) => filePath.endsWith("/status.json"))).toBe(false);
		expect(writers).toHaveLength(2);
		expectNoLaunchOrOwnedState();
		await expectNextAdmission();
	}, 20000);

	it("disposes pending index retries and both writers when the final prelaunch mark fails", async () => {
		vi.spyOn(activeIndex, "updateActiveRunIndex").mockImplementationOnce(() => { throw storageFault("ENOSPC"); });
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			const handle = acquireCapacity(input, options)!;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => {
				expect(writers[0]!.pendingCount()).toBe(1);
				throw storageFault("FINAL_MARK");
			});
			return handle;
		});
		const clearRetry = vi.spyOn(globalThis, "clearTimeout");
		const first = await execute("offline-final-mark-fault");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_FINAL_MARK") }));
		expect(writers).toHaveLength(2);
		expectNoLaunchOrOwnedState();
		expect(clearRetry).toHaveBeenCalled();
		await expectNextAdmission();
	}, 20000);

	it("retains a reservation if the started mark succeeds before a later marking error", async () => {
		let handle: capacity.ActiveAsyncCapacityHandle | undefined;
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			handle = acquireCapacity(input, options)!;
			const mark = handle.markWorkflowStarted;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => { mark(); throw storageFault("AFTER_STARTED_MARK"); });
			return handle;
		});
		const first = await execute("offline-started-mark-fault");
		expect(first.isError).toBe(true);
		expect(runSpy).not.toHaveBeenCalled();
		expect(state.workflowControllers?.size ?? 0).toBe(0);
		expect(state.asyncJobs.size).toBe(0);
		expect(state.fleetJobs?.size ?? 0).toBe(0);
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 1, limit: 1 });
		for (const writer of writers) expect(writer.dispose).toHaveBeenCalledTimes(1);
		if (!handle) throw new Error("Missing actual capacity handle");
		expect(JSON.parse(fs.readFileSync(join(handle.owner.asyncDir, "status.json"), "utf8"))).toMatchObject({ state: "running", workflowChildren: { inventoryComplete: false } });
		expect(activeIndex.readActiveRunIndex(DIRS.async)).toContain(handle.owner.runId);
		expect(activeIndex.readActiveRunToolCallIndex(DIRS.async, "offline-started-mark-fault")).toEqual([handle.owner.runId]);
		const next = await execute("offline-after-started-failure");
		expect(next.isError).toBe(true);
		expect(next.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("capacity exhausted: 1/1") }));
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("keeps live workflow capacity until its actual executor/Worker path finishes", async () => {
		const gate = new Promise<void>((resolve) => { releaseRunner = resolve; });
		runSpy.mockImplementation(async (options) => { await gate; return runWorkflowScript(options); });
		const first = await execute("offline-live-workflow");
		expect(first.isError).not.toBe(true);
		const runId = first.details.asyncId!;
		expect(state.workflowControllers?.has(runId)).toBe(true);
		const owner = capacity.inspectActiveAsyncCapacityOwner({ runId, sessionId }, { liveWorkflowRunIds: new Set(state.workflowControllers?.keys()) });
		expect(owner.owner?.runnerStartedAt).toEqual(expect.any(Number));
		expect(owner.release.state).toBe("retained");
		const second = await execute("offline-concurrent-workflow");
		expect(second.isError).toBe(true);
		expect(second.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("capacity exhausted: 1/1") }));
		expect(runSpy).toHaveBeenCalledTimes(1);
		releaseRunner!();
		await vi.waitFor(() => expect(state.workflowControllers?.has(runId)).toBe(false), { timeout: 10000 });
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 0, limit: 1 });
	}, 20000);

	it.each(["missing status", "unknown async-child proof"])("does not reclaim a started neighbor with %s", async (neighbor) => {
		const runId = "offline-started-neighbor";
		const asyncDir = join(DIRS.async, runId);
		const handle = acquireCapacity({ sessionId, limit: 1, runId, kind: "workflow", asyncDir })!;
		handle.markWorkflowStarted();
		if (neighbor === "unknown async-child proof") {
			const childRunId = "offline-unknown-child";
			const childDir = join(DIRS.async, childRunId);
			const now = Date.now();
			writeAtomicJson(join(asyncDir, "status.json"), { runId, sessionId, mode: "workflow", state: "failed", startedAt: now, lastUpdate: now,
				steps: [{ agent: "worker", workflowKey: "worker", runId: childRunId, status: "failed", async: true }] });
			const proof = { version: 1, state: "unknown", runId: childRunId, runnerProcessInstanceId: "offline-child-instance", reason: "writer-close-unverified" };
			writeAtomicJson(join(childDir, "status.json"), { runId: childRunId, sessionId, mode: "single", state: "failed", startedAt: now, lastUpdate: now, processTerminal: proof });
			writeAtomicJson(join(childDir, "process-terminal.json"), proof);
		}
		expect(handle.rollback()).toBe(false);
		const next = await execute("offline-unknown-neighbor-admission");
		expect(next.isError).toBe(true);
		expect(next.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("capacity exhausted: 1/1") }));
		expect(runSpy).not.toHaveBeenCalled();
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 1, limit: 1 });
	});

	it.each([
		{ label: "empty", id: "" },
		{ label: "whitespace-only", id: " \t" },
		{ label: "257-byte ASCII", id: "x".repeat(257) },
		{ label: "260-byte astral", id: "😀".repeat(65) },
	])("rejects $label tool-call IDs before stranding capacity, then admits actual work", async ({ id }) => {
		const first = await execute(id);
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("parentToolCallId") }));
		expect(writers).toHaveLength(0);
		expectNoLaunchOrOwnedState();
		await expectNextAdmission();
	}, 20000);

	it.each([
		{ label: "256-byte ASCII", id: "x".repeat(256) },
		{ label: "256-byte astral", id: "😀".repeat(64) },
		{ label: "256-byte trimmed neighbor", id: `${" ".repeat(254)}a ` },
		{ label: "256-byte mixed Unicode", id: `${"é".repeat(127)} x` },
	])("preserves the exact $label tool-call ID through receipt and persisted completion", async ({ id }) => {
		const first = await execute(id);
		expect(first.isError).not.toBe(true);
		expect(first.details.workflowChildren?.parentToolCallId).toBe(id);
		const runId = first.details.asyncId!;
		await vi.waitFor(() => expect(state.workflowControllers?.has(runId)).toBe(false), { timeout: 10000 });
		const status = JSON.parse(fs.readFileSync(join(first.details.asyncDir!, "status.json"), "utf8")) as AsyncStatus;
		expect(status).toMatchObject({ toolCallId: id, state: "complete", workflowChildren: { parentToolCallId: id, inventoryComplete: true }, workflow: { value: 1 } });
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 0, limit: 1 });
	}, 20000);

	it("contains the receipt fanout snapshot failure before mark/scheduling, then admits a real Worker", async () => {
		vi.spyOn(fanout, "getRunFanoutBudgetSnapshot").mockImplementationOnce(fanoutSnapshot).mockImplementationOnce(() => { throw storageFault("RECEIPT_SNAPSHOT"); });
		const first = await execute("offline-receipt-snapshot-fault");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_RECEIPT_SNAPSHOT") }));
		expectNoLaunchOrOwnedState();
		expect(listAsyncRuns(DIRS.async, { states: ["queued", "running"], sessionId, reconcile: false, includeNested: false })).toEqual([]);
		await expectNextAdmission();
	}, 20000);

	it("performs every start fanout projection before the irreversible mark and has no third receipt snapshot", async () => {
		let marked = false;
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			const handle = acquireCapacity(input, options)!;
			const mark = handle.markWorkflowStarted;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => { mark(); marked = true; });
			return handle;
		});
		const snapshot = vi.spyOn(fanout, "getRunFanoutBudgetSnapshot").mockImplementation((descriptor) => {
			if (marked) throw storageFault("AFTER_MARK_PROJECTION");
			return fanoutSnapshot(descriptor);
		});
		await expectNextAdmission();
		expect(marked).toBe(true);
		expect(snapshot).toHaveBeenCalledTimes(2);
	}, 20000);

	it("terminalizes successfully indexed disk truth only after proven unstarted rollback", async () => {
		let handle: capacity.ActiveAsyncCapacityHandle | undefined;
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			handle = acquireCapacity(input, options)!;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => { throw storageFault("BEFORE_MARK"); });
			return handle;
		});
		const first = await execute("offline-indexed-before-mark");
		expect(first.isError).toBe(true);
		expectNoLaunchOrOwnedState();
		if (!handle) throw new Error("Missing actual capacity handle");
		const { runId, asyncDir } = handle.owner;
		expect(handle.owner.runnerStartedAt).toBeUndefined();
		const status = JSON.parse(fs.readFileSync(join(asyncDir, "status.json"), "utf8")) as AsyncStatus;
		expect(status).toMatchObject({ state: "failed", error: expect.stringContaining("OFFLINE_INITIALIZATION_BEFORE_MARK"), endedAt: expect.any(Number), workflowChildren: { workflowState: "failed", inventoryComplete: true } });
		expect(status.processTerminal).toBeUndefined();
		expect(activeIndex.readActiveRunIndex(DIRS.async) ?? []).not.toContain(runId);
		expect(activeIndex.readActiveRunToolCallIndex(DIRS.async, "offline-indexed-before-mark")).toEqual([]);
		expect(listAsyncRuns(DIRS.async, { states: ["queued", "running"], sessionId, reconcile: false, includeNested: false })).toEqual([]);
		await expectNextAdmission();
	}, 20000);

	it("cleans known-unlaunched durable truth when capacity is unlimited", async () => {
		executor = createExecutor(0);
		vi.spyOn(fanout, "getRunFanoutBudgetSnapshot").mockImplementationOnce(fanoutSnapshot).mockImplementationOnce(() => { throw storageFault("UNLIMITED_RECEIPT"); });
		const writes = vi.spyOn(atomic, "writeAtomicJson");
		const first = await execute("offline-unlimited-receipt-fault");
		expect(first.isError).toBe(true);
		expectNoLaunchOrOwnedState();
		const statusPath = writes.mock.calls.find(([filePath]) => filePath.endsWith("/status.json"))?.[0];
		if (!statusPath) throw new Error("Missing actual persisted status path");
		expect(JSON.parse(fs.readFileSync(statusPath, "utf8"))).toMatchObject({ state: "failed", workflowChildren: { inventoryComplete: true, workflowState: "failed" } });
		expect(activeIndex.readActiveRunIndex(DIRS.async) ?? []).toEqual([]);
		expect(activeIndex.readActiveRunToolCallIndex(DIRS.async, "offline-unlimited-receipt-fault")).toEqual([]);
		expect(listAsyncRuns(DIRS.async, { states: ["queued", "running"], sessionId, reconcile: false, includeNested: false })).toEqual([]);
	}, 20000);

	it.each([0, 1])("handles a status write that throws after committing with capacity limit %s", async (limit) => {
		executor = createExecutor(limit);
		const writes = vi.spyOn(atomic, "writeAtomicJson").mockImplementationOnce((filePath, payload) => {
			writeAtomicJson(filePath, payload);
			throw storageFault("AFTER_STATUS_COMMIT");
		});
		const first = await execute("offline-after-status-commit");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_AFTER_STATUS_COMMIT") }));
		expectNoLaunchOrOwnedState();
		const statusPath = writes.mock.calls[0]?.[0];
		if (!statusPath) throw new Error("Missing actual persisted status path");
		expect(JSON.parse(fs.readFileSync(statusPath, "utf8"))).toMatchObject({ state: "failed", endedAt: expect.any(Number) });
		expect(activeIndex.readActiveRunIndex(DIRS.async) ?? []).toEqual([]);
	}, 20000);

	it.each(["status", "index"] as const)("reports %s cleanup I/O failure alongside the original initialization error", async (phase) => {
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			const handle = acquireCapacity(input, options)!;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => { throw storageFault("PRIMARY_MARK"); });
			return handle;
		});
		if (phase === "status") vi.spyOn(atomic, "writeAtomicJson").mockImplementation((filePath, payload) => {
			if (filePath.endsWith("/status.json") && "state" in payload && payload.state === "failed") throw storageFault("CLEANUP_STATUS");
			writeAtomicJson(filePath, payload);
		});
		else vi.spyOn(activeIndex, "updateActiveRunIndex").mockImplementation((asyncDir, status, toolCallId, options) => {
			if (status === "failed") throw storageFault("CLEANUP_INDEX");
			updateActiveRunIndex(asyncDir, status, toolCallId, options);
		});
		const first = await execute("offline-cleanup-io-fault");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_PRIMARY_MARK") }));
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining(`OFFLINE_INITIALIZATION_CLEANUP_${phase.toUpperCase()}`) }));
		expectNoLaunchOrOwnedState();
	});

	it.each([1, 2])("disposes every already-created writer when writer construction %s fails", async (position) => {
		const factory = vi.spyOn(persistence, "createCapacityResilientJsonWriter");
		if (position === 2) factory.mockImplementationOnce(createTrackedWriter);
		factory.mockImplementationOnce(() => { throw storageFault("WRITER_CONSTRUCTION"); });
		const first = await execute("offline-writer-construction");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("WRITER_CONSTRUCTION") }));
		expect(writers).toHaveLength(position - 1);
		expectNoLaunchOrOwnedState();
		await expectNextAdmission();
	}, 20000);

	it.each(["changed session", "unknown process proof", "unknown child inventory"])("retains %s durable evidence rather than overwriting uncertain ownership", async (phase) => {
		let handle: capacity.ActiveAsyncCapacityHandle | undefined;
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			handle = acquireCapacity(input, options)!;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => {
				const statusPath = join(handle!.owner.asyncDir, "status.json");
				const status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as AsyncStatus;
				if (phase === "changed session") status.sessionId = "offline-different-owner";
				else if (phase === "unknown child inventory") status.workflowChildren!.children.push({ childId: "unknown-child", runId: "offline-unknown-child-run", state: "running" });
				else status.processTerminal = { version: 1, state: "unknown", runId: handle!.owner.runId, runnerProcessInstanceId: "offline-unknown-instance", reason: "writer-close-unverified" };
				writeAtomicJson(statusPath, status);
				throw storageFault("OWNERSHIP_CHANGED");
			});
			return handle;
		});
		const first = await execute("offline-durable-ownership-changed");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OWNERSHIP_CHANGED") }));
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("durable startup ownership changed") }));
		expectNoLaunchOrOwnedState();
		if (!handle) throw new Error("Missing actual capacity handle");
		const status = JSON.parse(fs.readFileSync(join(handle.owner.asyncDir, "status.json"), "utf8")) as AsyncStatus;
		expect(status.state).toBe("running");
		if (phase === "changed session") expect(status.sessionId).toBe("offline-different-owner");
		else if (phase === "unknown child inventory") expect(status.workflowChildren?.children).toEqual([{ childId: "unknown-child", runId: "offline-unknown-child-run", state: "running" }]);
		else expect(status.processTerminal?.state).toBe("unknown");
		expect(activeIndex.readActiveRunIndex(DIRS.async)).toContain(handle.owner.runId);
		expect(activeIndex.readActiveRunToolCallIndex(DIRS.async, "offline-durable-ownership-changed")).toEqual([handle.owner.runId]);
	});

	it("contains mission-state handle initialization before admission", async () => {
		vi.spyOn(missionLifecycle, "prepareMissionLaunch").mockReturnValue({ missionId: "offline-mission", autoCreated: true, location: { projectRoot: directory, missionDir: join(directory, "missions"), globalIndexDir: join(directory, "mission-index"), writeGlobalIndex: false } });
		vi.spyOn(missionState, "createMissionWorkflowState").mockImplementationOnce(() => { throw storageFault("MISSION_STATE_HANDLE"); });
		const first = await executor.execute("offline-mission-state-handle", { ...params, mission: undefined, missionId: "offline-mission", runFanoutBudget: budget }, new AbortController().signal, undefined, ctx);
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("MISSION_STATE_HANDLE") }));
		expectNoLaunchOrOwnedState();
	});

	it.each(["automatic", "explicit"])("preserves actual started receipt and live ownership after %s mission attachment fails", async (mode) => {
		const gate = new Promise<void>((resolve) => { releaseRunner = resolve; });
		runSpy.mockImplementation(async (options) => { await gate; return runWorkflowScript(options); });
		vi.spyOn(missionLifecycle, "prepareMissionLaunch").mockReturnValue({ missionId: "offline-mission", autoCreated: mode === "automatic", location: { projectRoot: directory, missionDir: join(directory, "missions"), globalIndexDir: join(directory, "mission-index"), writeGlobalIndex: false } });
		vi.spyOn(missionLifecycle, "attachMissionToLaunchResult").mockImplementation(() => { throw storageFault("MISSION_ATTACHMENT"); });
		const first = await executor.execute("offline-post-admission-mission", { ...params, mission: undefined, ...(mode === "explicit" ? { missionId: "offline-mission" } : {}), runFanoutBudget: budget }, new AbortController().signal, undefined, ctx);
		expect(first.isError).toBe(mode === "explicit" ? true : undefined);
		expect(first.details.missionWarning).toContain("MISSION_ATTACHMENT");
		expect(first.details.asyncId).toEqual(expect.any(String));
		expect(first.details.activeAsyncCapacity).toEqual({ used: 1, limit: 1 });
		expect(state.workflowControllers?.has(first.details.asyncId!)).toBe(true);
		expect(runSpy).toHaveBeenCalledTimes(1);
		for (const writer of writers) expect(writer.dispose).not.toHaveBeenCalled();
		releaseRunner!();
		await vi.waitFor(() => expect(state.workflowControllers?.has(first.details.asyncId!)).toBe(false), { timeout: 10000 });
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 0, limit: 1 });
	}, 20000);

	it.each(["authoritative marker", "alias enumeration", "alias removal", "terminal EACCES", "terminal ENOSPC", "status read"] as const)("reports actual %s cleanup I/O alongside the original error", async (phase) => {
		let handle: capacity.ActiveAsyncCapacityHandle | undefined;
		let cleanupStarted = false;
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			handle = acquireCapacity(input, options)!;
			vi.spyOn(handle, "markWorkflowStarted").mockImplementation(() => {
				cleanupStarted = true;
				if (phase === "alias enumeration") vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => { throw storageFault("ACTUAL_ALIAS_ENUMERATION"); });
				if (phase === "status read") vi.spyOn(fs, "statSync").mockImplementationOnce(() => { throw storageFault("ACTUAL_STATUS_READ"); });
				syncBuiltinESMExports();
				throw storageFault("PRIMARY_ACTUAL_IO");
			});
			return handle;
		});
		if (phase === "authoritative marker" || phase === "alias removal") vi.spyOn(fs, "rmSync").mockImplementation((filePath, options) => {
			const text = String(filePath);
			const isAlias = text.includes("/tool-calls/");
			if (cleanupStarted && text.endsWith(`/${handle!.owner.runId}`) && text.includes("/.active-runs/") && (phase === "alias removal" ? isAlias : !isAlias)) throw storageFault(`ACTUAL_${phase === "alias removal" ? "ALIAS_REMOVAL" : "MARKER"}`);
			removeFile(filePath, options);
		});
		if (phase.startsWith("terminal")) vi.spyOn(atomic, "writeAtomicJson").mockImplementation((filePath, payload) => {
			if (cleanupStarted && filePath.includes("/.terminal-runs/")) throw storageFault(phase === "terminal ENOSPC" ? "ENOSPC" : "EACCES");
			writeAtomicJson(filePath, payload);
		});
		const first = await execute("offline-actual-index-cleanup");
		expect(first.isError).toBe(true);
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("OFFLINE_INITIALIZATION_PRIMARY_ACTUAL_IO") }));
		const secondary = phase === "authoritative marker" ? "ACTUAL_MARKER" : phase === "alias enumeration" ? "ACTUAL_ALIAS_ENUMERATION" : phase === "alias removal" ? "ACTUAL_ALIAS_REMOVAL" : phase === "status read" ? "ACTUAL_STATUS_READ" : phase === "terminal ENOSPC" ? "ENOSPC" : "EACCES";
		expect(first.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining(`OFFLINE_INITIALIZATION_${secondary}`) }));
		expectNoLaunchOrOwnedState();
		if (!handle) throw new Error("Missing actual capacity handle");
		if (phase !== "status read") expect(JSON.parse(fs.readFileSync(join(handle.owner.asyncDir, "status.json"), "utf8"))).toMatchObject({ state: "failed", error: expect.stringContaining("PRIMARY_ACTUAL_IO") });
		if (phase === "authoritative marker" || phase.startsWith("alias")) expect(readRecentTerminalRunIndex(DIRS.async, { sessionId })).toContain(handle.owner.runId);
		if (phase === "authoritative marker") expect(activeIndex.readActiveRunToolCallIndex(DIRS.async, "offline-actual-index-cleanup")).toEqual([]);
	}, 20000);

	it("retains actual owner-write uncertainty while a real Worker is live", async () => {
		const gate = new Promise<void>((resolve) => { releaseRunner = resolve; });
		runSpy.mockImplementation(async (options) => { await gate; return runWorkflowScript(options); });
		let handle: capacity.ActiveAsyncCapacityHandle | undefined;
		vi.spyOn(capacity, "acquireActiveAsyncCapacity").mockImplementationOnce((input, options) => {
			handle = acquireCapacity(input, options);
			return handle;
		});
		vi.spyOn(atomic, "writePrivateAtomicJson").mockImplementation((filePath, payload) => {
			if (filePath.endsWith("/owner.json") && "runnerStartedAt" in payload) throw storageFault("OWNER_WRITE_UNCERTAINTY");
			writePrivateAtomicJson(filePath, payload);
		});
		const first = await execute("offline-owner-write-uncertainty");
		expect(first.isError).not.toBe(true);
		if (!handle) throw new Error("Missing actual capacity handle");
		expect(handle.owner.runnerStartedAt).toEqual(expect.any(Number));
		expect(handle.rollback()).toBe(false);
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 1, limit: 1 });
		expect(JSON.parse(fs.readFileSync(join(first.details.asyncDir!, "status.json"), "utf8"))).toMatchObject({ state: "running", workflowChildren: { inventoryComplete: false } });
		const next = await execute("offline-during-owner-uncertainty");
		expect(next.isError).toBe(true);
		releaseRunner!();
		await vi.waitFor(() => expect(state.workflowControllers?.has(first.details.asyncId!)).toBe(false), { timeout: 10000 });
		expect(capacitySnapshot(sessionId, 1)).toEqual({ used: 0, limit: 1 });
	}, 20000);

	it("uses the session-file identity for reservation, status and result rather than the differing session ID", async () => {
		const sessionFile = join(directory, "parent-session.jsonl");
		capacityIdentities.add(sessionFile);
		ctx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
		const acquire = vi.spyOn(capacity, "acquireActiveAsyncCapacity");
		const first = await execute("offline-session-file-precedence");
		expect(first.isError).not.toBe(true);
		expect(acquire.mock.calls[0]?.[0].sessionId).toBe(sessionFile);
		await vi.waitFor(() => expect(state.workflowControllers?.has(first.details.asyncId!)).toBe(false), { timeout: 10000 });
		expect(JSON.parse(fs.readFileSync(join(first.details.asyncDir!, "status.json"), "utf8"))).toMatchObject({ sessionId: sessionFile, state: "complete" });
		expect(JSON.parse(fs.readFileSync(resultFilePath(DIRS.results, first.details.asyncId!), "utf8"))).toMatchObject({ sessionId: sessionFile, state: "complete" });
		expect(capacitySnapshot(sessionFile, 1)).toEqual({ used: 0, limit: 1 });
	}, 20000);
});
