import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledRunManager, type ScheduleRecord, type ScheduleRunRecord, scheduledRunStorePath } from "../src/runs/background/scheduled-runs.ts";
import type { ExtensionConfig } from "../src/shared/types.ts";
import type { SubagentParamsLike } from "../src/runs/foreground/subagent-executor.ts";

let directory: string;
let now: number;
let manager: ReturnType<typeof createScheduledRunManager>;
const launch = vi.fn(async (_params: SubagentParamsLike, _ctx: ExtensionContext, _signal: AbortSignal) => ({ content: [{ type: "text" as const, text: "offline" }], details: { mode: "workflow" as const, results: [], asyncId: "owned-offline-run" } }));
const writeFileSync = fs.writeFileSync;

beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), "pi-schedule-regression-"));
	now = 1000;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	launch.mockClear();
	manager = createScheduledRunManager({ config: {} as ExtensionConfig, now: () => now, launch });
});
afterEach(() => {
	manager.stop();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.useRealTimers();
	fs.rmSync(directory, { recursive: true, force: true });
});

function context(cwd: string, trust = { trusted: true }): ExtensionContext {
	return { cwd, isProjectTrusted: () => trust.trusted, sessionManager: { getSessionId: () => `offline-${cwd}`, getSessionFile: () => undefined } } as unknown as ExtensionContext;
}

function persist(cwd: string, id = "probe", overrides: Record<string, unknown> = {}): string {
	const dir = join(scheduledRunStorePath(cwd), id);
	fs.mkdirSync(dir, { recursive: true });
	const record: ScheduleRecord = { schemaVersion: 1, id, name: "offline", cwd,
		trigger: { kind: "once", at: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() },
		target: { workflowScript: "return 1;" }, overlap: "skip", catchUp: "latest", paused: false,
		createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
	fs.writeFileSync(join(dir, "schedule.json"), JSON.stringify({ ...record, ...overrides }));
	return dir;
}

function record(dir: string): ScheduleRecord {
	return JSON.parse(fs.readFileSync(join(dir, "schedule.json"), "utf8")) as ScheduleRecord;
}
function history(dir: string): { runs: ScheduleRunRecord[] } {
	return JSON.parse(fs.readFileSync(join(dir, "history.json"), "utf8")) as { runs: ScheduleRunRecord[] };
}

describe("schedule trust boundaries", () => {
	it("does not restore or arm declined projects, even during inert inspection", async () => {
		const dir = persist(directory);
		const original = fs.readFileSync(join(dir, "schedule.json"), "utf8");
		const ctx = context(directory, { trusted: false });
		manager.bindSession(ctx);
		for (const action of ["schedule.list", "schedule.show", "schedule.history"]) {
			const result = await manager.handleToolCall({ action, id: "probe" }, ctx);
			expect(result.isError).not.toBe(true);
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(launch).not.toHaveBeenCalled();
		expect(fs.existsSync(join(dir, "history.json"))).toBe(false);
		expect(fs.readFileSync(join(dir, "schedule.json"), "utf8")).toBe(original);
	});
	it.each(["schedule.create", "schedule.resume", "schedule.run", "schedule.run-due"])("rejects untrusted %s without mutation", async (action) => {
		const dir = persist(directory);
		const original = fs.readFileSync(join(dir, "schedule.json"), "utf8");
		const result = await manager.handleToolCall({ action, id: "probe", at: "+1s", workflowScript: "return 1;" }, context(directory, { trusted: false }));
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("project trust") });
		expect(vi.getTimerCount()).toBe(0);
		expect(launch).not.toHaveBeenCalled();
		expect(fs.readFileSync(join(dir, "schedule.json"), "utf8")).toBe(original);
	});
	it("keeps pause and delete available without activating work", async () => {
		const dir = persist(directory);
		const ctx = context(directory, { trusted: false });
		expect((await manager.handleToolCall({ action: "schedule.pause", id: "probe" }, ctx)).isError).not.toBe(true);
		expect(record(dir).paused).toBe(true);
		expect((await manager.handleToolCall({ action: "schedule.delete", id: "probe" }, ctx)).isError).not.toBe(true);
		expect(fs.existsSync(dir)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(launch).not.toHaveBeenCalled();
	});
	it("uses the selected captured project's decision, not an unrelated caller's trust", async () => {
		const trustedProject = join(directory, "trusted");
		const declinedProject = join(directory, "declined");
		persist(trustedProject);
		persist(declinedProject);
		const trustedCtx = context(trustedProject);
		const declinedCtx = context(declinedProject, { trusted: false });
		manager.bindSession(trustedCtx);
		manager.bindSession(declinedCtx);
		expect(vi.getTimerCount()).toBe(1);
		const denied = await manager.handleToolCall({ action: "schedule.run", id: "probe", cwd: declinedProject }, trustedCtx);
		expect(denied.isError).toBe(true);
		const allowed = await manager.handleToolCall({ action: "schedule.run", id: "probe", cwd: trustedProject }, declinedCtx);
		expect(allowed.isError).not.toBe(true);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(launch.mock.calls[0]?.[1]).toMatchObject({ cwd: trustedProject });
	});
	it("rechecks trust before a previously armed tick", async () => {
		const dir = persist(directory);
		const trust = { trusted: true };
		manager.bindSession(context(directory, trust));
		expect(vi.getTimerCount()).toBe(1);
		trust.trusted = false;
		now = 2000;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(fs.existsSync(join(dir, "history.json"))).toBe(false);
	});
	it("rechecks trust after claim persistence immediately before launch", async () => {
		const dir = persist(directory);
		const trust = { trusted: true };
		const ctx = context(directory, trust);
		manager.bindSession(ctx);
		vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
			writeFileSync(...args);
			if (String(args[0]).includes("history.json")) trust.trusted = false;
		});
		syncBuiltinESMExports();
		const result = await manager.handleToolCall({ action: "schedule.run", id: "probe" }, ctx);
		expect(result.isError).toBe(true);
		expect(launch).not.toHaveBeenCalled();
		expect(history(dir).runs[0]).toMatchObject({ state: "failed_launch", error: expect.stringContaining("project trust") });
		expect(record(dir).activeRunId).toBeUndefined();
		expect(fs.existsSync(join(dir, "active.lock"))).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("preserves launched ownership and completion receipts after trust revocation", async () => {
		const dir = persist(directory);
		const trust = { trusted: true };
		const ctx = context(directory, trust);
		await manager.handleToolCall({ action: "schedule.run", id: "probe" }, ctx);
		trust.trusted = false;
		manager.bindSession(ctx);
		expect(launch.mock.calls[0]?.[2].aborted).toBe(false);
		manager.handleAsyncCompletion({ runId: "owned-offline-run", success: true });
		expect(history(dir).runs[0]?.state).toBe("completed");
		expect(record(dir).activeRunId).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("persisted schedule trigger validation", () => {
	const validTrigger = { kind: "interval", every: "1m", everyMs: 60000, anchorAt: new Date(0).toISOString(), nextRunAt: new Date(2000).toISOString() };
	it.each([0, -60000, 0.5, null, 30000, 2 ** 53])("isolates invalid everyMs=%s while restoring valid records", async (everyMs) => {
		const invalid = persist(directory, "invalid", { trigger: { ...validTrigger, everyMs }, paused: false });
		persist(directory, "valid");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		manager.bindSession(context(directory));
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("Schedule 'invalid' could not be restored"));
		expect(vi.getTimerCount()).toBe(1);
		now = 2000;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(join(invalid, "history.json"))).toBe(false);
	});
	it.each(["invalid", "+999999-01-01T00:00:00Z", ""])("isolates invalid persisted dates (%j)", (nextRunAt) => {
		persist(directory, "invalid", { trigger: { ...validTrigger, nextRunAt } });
		persist(directory, "valid");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		manager.bindSession(context(directory));
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("invalid timestamp"));
		expect(vi.getTimerCount()).toBe(1);
	});
	it("allows valid past dates and advances extreme recurrence in bounded time", () => {
		now = 8_639_999_999_999_000;
		const earliest = new Date(-8_640_000_000_000_000).toISOString();
		const dir = persist(directory, "old", { trigger: { ...validTrigger, anchorAt: earliest, nextRunAt: earliest }, catchUp: "none" });
		manager.bindSession(context(directory));
		expect(record(dir).trigger.nextRunAt).toBe(new Date(8_640_000_000_000_000).toISOString());
		expect(history(dir).runs[0]?.state).toBe("missed");
		expect(vi.getTimerCount()).toBe(1);
	});
	it("contains Date overflow instead of arming an unsupported recurrence", () => {
		now = 8_640_000_000_000_000;
		persist(directory, "overflow", { trigger: { ...validTrigger, anchorAt: new Date(now).toISOString(), nextRunAt: new Date(now - 1).toISOString() }, catchUp: "none" });
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		manager.bindSession(context(directory));
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("outside the supported range"));
		expect(launch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

const armedIntervalTrigger: ScheduleRecord["trigger"] = { kind: "interval", every: "1m", everyMs: 60000, anchorAt: new Date(0).toISOString(), nextRunAt: new Date(2000).toISOString() };

const extremeTrigger: ScheduleRecord["trigger"] = { kind: "interval", every: "150119987579m", everyMs: 9007199254740000, anchorAt: new Date(0).toISOString(), nextRunAt: new Date(0).toISOString() };

describe("recurrence admission and known completion truth", () => {
	it("rejects unsupported future recurrence before claiming or publishing a running receipt", async () => {
		const dir = persist(directory, "extreme", { trigger: extremeTrigger });
		const before = fs.readFileSync(join(dir, "schedule.json"), "utf8");
		const result = await manager.handleToolCall({ action: "schedule.run-due" }, context(directory));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("outside the supported range") }]);
		expect(launch).not.toHaveBeenCalled();
		expect(fs.existsSync(join(dir, "active.lock"))).toBe(false);
		expect(fs.existsSync(join(dir, "history.json"))).toBe(false);
		expect(fs.readFileSync(join(dir, "schedule.json"), "utf8")).toBe(before);
		expect(manager.observedCompletionRunIds().size).toBe(0);
	});
	it("does not turn rejected recurrence admission into a false manual overlap", async () => {
		const dir = persist(directory, "extreme", { trigger: extremeTrigger });
		const rejected = await manager.handleToolCall({ action: "schedule.run-due" }, context(directory));
		expect(rejected.isError).toBe(true);
		const result = await manager.handleToolCall({ action: "schedule.run", id: "extreme" }, context(directory));
		expect(result.isError).not.toBe(true);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(history(dir).runs).toHaveLength(1);
		expect(history(dir).runs[0]).toMatchObject({ state: "running", dueReason: "manual", asyncId: "owned-offline-run" });
		expect(fs.readFileSync(join(dir, "active.lock"), "utf8")).toBe(record(dir).activeRunId);
	});
	it("contains timer recurrence overflow without a claim, synthetic history or repeated timers", async () => {
		const dir = persist(directory, "extreme", { trigger: extremeTrigger });
		const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
		manager.bindSession(context(directory));
		await vi.runOnlyPendingTimersAsync();
		expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("outside the supported range"));
		expect(launch).not.toHaveBeenCalled();
		expect(fs.existsSync(join(dir, "active.lock"))).toBe(false);
		expect(fs.existsSync(join(dir, "history.json"))).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([true, false])("publishes known terminal success=%s even when the future projection fails", async success => {
		const dir = persist(directory, "extreme", { trigger: extremeTrigger });
		await manager.handleToolCall({ action: "schedule.run", id: "extreme" }, context(directory));
		expect(manager.observedCompletionRunIds().has("owned-offline-run")).toBe(true);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		manager.handleAsyncCompletion({ runId: "owned-offline-run", success, summary: "actual child result" });
		expect(history(dir).runs).toHaveLength(1);
		expect(history(dir).runs[0]).toMatchObject({ state: success ? "completed" : "failed_run", completedAt: new Date(now).toISOString(), ...(success ? {} : { error: "actual child result" }) });
		expect(record(dir).activeRunId).toBeUndefined();
		expect(record(dir).trigger).toEqual(extremeTrigger);
		expect(record(dir).paused).toBe(false);
		expect(fs.existsSync(join(dir, "active.lock"))).toBe(false);
		expect(manager.observedCompletionRunIds().size).toBe(0);
		expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("async completion"), expect.objectContaining({ message: expect.stringContaining("outside the supported range") }));
		await vi.runOnlyPendingTimersAsync();
		expect(launch).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(history(dir).runs).toHaveLength(1);
		manager.handleAsyncCompletion({ runId: "owned-offline-run", success, summary: "duplicate" });
		expect(history(dir).runs).toHaveLength(1);
	});
	it.each(["definition", "history", "claim"] as const)("retains observer ownership and both errors if projection plus %s publication fails", async destination => {
		const dir = persist(directory, "extreme", { trigger: extremeTrigger });
		await manager.handleToolCall({ action: "schedule.run", id: "extreme" }, context(directory));
		const persistenceError = Object.assign(new Error("completion publication denied"), { code: "EACCES" });
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		if (destination === "claim") {
			const remove = fs.rmSync;
			vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
				if (file === join(dir, "active.lock")) throw persistenceError;
				return remove(file, options);
			});
		} else {
			vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
				if (typeof file === "string" && file.startsWith(join(dir, destination === "definition" ? ".schedule.json." : ".history.json."))) throw persistenceError;
				return writeFileSync(file, data, options);
			});
		}
		syncBuiltinESMExports();
		manager.handleAsyncCompletion({ runId: "owned-offline-run", success: true });
		expect(diagnostic).toHaveBeenCalled();
		const combined = diagnostic.mock.calls[0]?.[1];
		if (!(combined instanceof AggregateError)) throw new Error("Expected honest paired projection/persistence failure");
		expect(combined.errors).toHaveLength(2);
		expect(combined.errors[0]).toMatchObject({ message: expect.stringContaining("outside the supported range") });
		expect(combined.errors[1]).toBe(persistenceError);
		expect(manager.observedCompletionRunIds().has("owned-offline-run")).toBe(true);
		expect(history(dir).runs[0]?.state).toBe("running");
		expect(launch).toHaveBeenCalledTimes(1);
		if (destination !== "history") expect(fs.existsSync(join(dir, "active.lock"))).toBe(true);
	});
	it("keeps normal failed terminal persistence visible and observed without changing its error", async () => {
		const dir = persist(directory, "ordinary");
		await manager.handleToolCall({ action: "schedule.run", id: "ordinary" }, context(directory));
		const persistenceError = Object.assign(new Error("ordinary completion denied"), { code: "EACCES" });
		vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
			if (typeof file === "string" && file.startsWith(join(dir, ".schedule.json."))) throw persistenceError;
			return writeFileSync(file, data, options);
		});
		syncBuiltinESMExports();
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		manager.handleAsyncCompletion({ runId: "owned-offline-run", success: true });
		expect(diagnostic).toHaveBeenCalledWith(expect.any(String), persistenceError);
		expect(manager.observedCompletionRunIds().has("owned-offline-run")).toBe(true);
		expect(fs.existsSync(join(dir, "active.lock"))).toBe(true);
		expect(history(dir).runs[0]?.state).toBe("running");
	});
});

describe("actual armed occurrence versus missed catch-up work", () => {
	it.each(["once", "interval"] as const)("executes genuinely armed %s despite ordinary1ms timer lateness", async kind => {
		const trigger: ScheduleRecord["trigger"] = kind === "once" ? { kind, at: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() } : { ...armedIntervalTrigger, anchorAt: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() };
		const dir = persist(directory, "armed", { trigger, catchUp: "none" });
		manager.bindSession(context(directory));
		expect(vi.getTimerCount()).toBe(1);
		now = 2001;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(history(dir).runs).toHaveLength(1);
		expect(history(dir).runs[0]).toMatchObject({ state: "running", dueReason: "timer", plannedAt: new Date(2000).toISOString() });
		if (kind === "interval") expect(record(dir).trigger.nextRunAt).toBe(new Date(62000).toISOString());
		else expect(record(dir).trigger.nextRunAt).toBeUndefined();
	});
	it("executes one owned interval occurrence after long lateness and advances beyond now", async () => {
		const dir = persist(directory, "armed", { trigger: { ...armedIntervalTrigger, anchorAt: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() }, catchUp: "none" });
		manager.bindSession(context(directory));
		now = 180001;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(history(dir).runs).toHaveLength(1);
		expect(history(dir).runs[0]).toMatchObject({ state: "running", plannedAt: new Date(2000).toISOString() });
		expect(record(dir).trigger.nextRunAt).toBe(new Date(182000).toISOString());
	});
	it.each(["once", "interval"] as const)("does not give a newly replaced late %s occurrence stale timer authority", async kind => {
		const trigger: ScheduleRecord["trigger"] = kind === "once" ? { kind, at: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() } : { ...armedIntervalTrigger, anchorAt: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() };
		const dir = persist(directory, "changed", { trigger, catchUp: "none" });
		manager.bindSession(context(directory));
		const latest = record(dir);
		latest.trigger = kind === "once" ? { kind, at: new Date(1999).toISOString(), nextRunAt: new Date(1999).toISOString() } : { ...armedIntervalTrigger, anchorAt: new Date(1999).toISOString(), nextRunAt: new Date(1999).toISOString() };
		fs.writeFileSync(join(dir, "schedule.json"), JSON.stringify(latest));
		now = 2001;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).not.toHaveBeenCalled();
		expect(history(dir).runs[0]).toMatchObject({ state: "missed", plannedAt: new Date(1999).toISOString() });
	});
	it("re-arms a clamped long wait instead of treating the early callback as due", async () => {
		const target = now + 2_147_483_647 + 1000;
		const dir = persist(directory, "distant", { trigger: { kind: "once", at: new Date(target).toISOString(), nextRunAt: new Date(target).toISOString() }, catchUp: "none" });
		manager.bindSession(context(directory));
		now += 2_147_483_647;
		await vi.advanceTimersByTimeAsync(2_147_483_647);
		expect(launch).not.toHaveBeenCalled();
		expect(fs.existsSync(join(dir, "history.json"))).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		now = target + 1;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(history(dir).runs[0]).toMatchObject({ state: "running", plannedAt: new Date(target).toISOString() });
	});
	it("still misses late one-shot catchUp:none work on startup rather than fabricating an arm", () => {
		const dir = persist(directory, "missed", { trigger: { kind: "once", at: new Date(0).toISOString(), nextRunAt: new Date(0).toISOString() }, catchUp: "none" });
		manager.bindSession(context(directory));
		expect(launch).not.toHaveBeenCalled();
		expect(history(dir).runs[0]).toMatchObject({ state: "missed", plannedAt: new Date(0).toISOString() });
		expect(vi.getTimerCount()).toBe(0);
	});
	it("still misses a late one-shot run-due with catchUp:none", async () => {
		const dir = persist(directory, "missed", { trigger: { kind: "once", at: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() }, catchUp: "none" });
		const ctx = context(directory);
		manager.bindSession(ctx);
		now = 2001;
		const result = await manager.handleToolCall({ action: "schedule.run-due" }, ctx);
		expect(result.isError).not.toBe(true);
		expect(launch).not.toHaveBeenCalled();
		expect(history(dir).runs[0]).toMatchObject({ state: "missed", dueReason: "run-due" });
	});
	it("does not let genuine armed identity bypass revocation of project trust", async () => {
		persist(directory, "revoked", { trigger: { kind: "once", at: new Date(2000).toISOString(), nextRunAt: new Date(2000).toISOString() }, catchUp: "none" });
		const trust = { trusted: true };
		const ctx = context(directory, trust);
		manager.bindSession(ctx);
		trust.trusted = false;
		now = 2001;
		await vi.advanceTimersByTimeAsync(1000);
		expect(launch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
