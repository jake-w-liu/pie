import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentExecutor } from "../src/runs/foreground/subagent-executor.ts";
import { reconcileDetachedWorkflowChildCompletion } from "../src/runs/foreground/workflow-detach-reconcile.ts";
import { createRunFanoutBudget } from "../src/runs/shared/run-fanout-budget.ts";
import { resultFilePath } from "../src/runs/background/result-files.ts";
import { DIRS, type AsyncStatus, type SubagentState } from "../src/shared/types.ts";
import * as workflow from "../src/workflows/scripted-workflow.ts";
import { readWorkflowReceipt } from "../src/workflows/workflow-receipt.ts";

const runWorkflowScript = workflow.runWorkflowScript;
function child(key: string): workflow.WorkflowScriptChildResult {
	return { key, ok: false, detached: true, runId: "offline-child", agent: "worker", output: "Detached for supervisor approval.", artifactPaths: [] };
}

describe("detached workflow sandbox classification", () => {
	it("preserves only detached-child on a context Error and retains partial results", async () => {
		const launched: string[] = [];
		let failure: unknown;
		try {
			await runWorkflowScript({
				script: `try { await runs.run("worker", { agent: "worker", task: "approval" }); } catch (error) {
					let escape = "not-tested"; try { escape = error.constructor.constructor("return typeof process")(); } catch { escape = "blocked"; }
					emit({ contextError: error instanceof Error, kind: error.workflowErrorKind, escape }); throw error;
				} await runs.run("review", { agent: "reviewer", task: "review" });`,
				launch: async (key) => { launched.push(key); return child(key); },
				status: async (key) => child(key),
			});
		} catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(workflow.WorkflowScriptError);
		const error = failure as workflow.WorkflowScriptError;
		expect(error.errorKind).toBe("detached-child");
		expect(error.partial.children).toEqual([expect.objectContaining({ key: "worker", detached: true, runId: "offline-child" })]);
		expect(error.partial.emits).toEqual([{ contextError: true, kind: "detached-child", escape: "blocked" }]);
		expect(error.partial.trace).toContainEqual(expect.objectContaining({ key: "worker", state: "detached" }));
		expect(launched).toEqual(["worker"]);
	});
	it("does not transfer arbitrary host error classifications, stacks or properties", async () => {
		const result = await runWorkflowScript({
			script: `try { await state.get("key"); } catch (error) {
				let escape = "not-tested"; try { escape = error.constructor.constructor("return typeof process")(); } catch { escape = "blocked"; }
				return { contextError: error instanceof Error, kind: error.workflowErrorKind, secret: error.privatePayload, stackLeaked: error.stack.includes("HOST_STACK_SENTINEL"), escape };
			}`,
			launch: async (key) => child(key), status: async (key) => child(key),
			state: { get: async () => { throw Object.assign(new Error("host failed"), { workflowErrorKind: "unknown-host-kind", privatePayload: () => process, stack: "HOST_STACK_SENTINEL" }); }, set: async () => {} },
		});
		expect(result.value).toEqual({ contextError: true, kind: undefined, secret: undefined, stackLeaked: false, escape: "blocked" });
	});
});

describe("async executor detached accounting (source integration)", () => {
	const originalDirs = { ...DIRS };
	let directory: string;
	let budget: ReturnType<typeof createRunFanoutBudget>;
	let state: SubagentState;
	let launches: string[];
	let realFailure: boolean;
	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-workflow-detach-regression-"));
		Object.assign(DIRS, { async: join(directory, "async"), results: join(directory, "results"), chain: join(directory, "chain"), artifacts: join(directory, "artifacts") });
		budget = createRunFanoutBudget("offline-detach-fixture", 4);
		state = { baseCwd: directory, currentSessionId: "offline-session", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
			cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} } };
		launches = [];
		realFailure = false;
		// Keep the actual worker, script, admission and persistence callbacks. Only
		// the child adapter is deterministic and never contacts a real provider.
		vi.spyOn(workflow, "runWorkflowScript").mockImplementation((options) => runWorkflowScript({ ...options,
			launch: async (key) => { launches.push(key); return realFailure && key === "review" ? { key, ok: false, error: "real child failure", output: "real child failure", artifactPaths: [] } : child(key); },
			status: async (key) => child(key),
		}));
	});
	afterEach(async () => {
		for (const controller of state.workflowControllers?.values() ?? []) controller.abort();
		await vi.waitFor(() => expect(state.workflowControllers?.size ?? 0).toBe(0));
		vi.restoreAllMocks();
		Object.assign(DIRS, originalDirs);
		fs.rmSync(directory, { recursive: true, force: true });
		fs.rmSync(budget.directory, { recursive: true, force: true });
	});
	async function execute(script: string): Promise<{ runId: string; dir: string; status: AsyncStatus; result: Record<string, unknown> }> {
		const ctx = { cwd: directory, hasUI: false, isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "offline-session", getSessionFile: () => join(directory, "parent.jsonl") } } as unknown as ExtensionContext;
		const executor = createSubagentExecutor({ pi: {} as ExtensionAPI, state, config: { artifactDir: "project" }, asyncByDefault: true,
			tempArtifactsDir: join(directory, "artifacts"), getSubagentSessionRoot: () => join(directory, "sessions"), expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }) });
		const receipt = await executor.execute("offline-parent-call", { workflowScript: script, async: true, mission: false, output: false,
			workflowParentRunId: "offline-parent", runFanoutBudget: budget }, new AbortController().signal, undefined, ctx);
		expect(receipt.isError).not.toBe(true);
		const runId = receipt.details.asyncId!;
		const dir = receipt.details.asyncDir!;
		await vi.waitFor(() => expect(state.workflowControllers?.has(runId)).toBe(false), { timeout: 10000 });
		return { runId, dir, status: JSON.parse(fs.readFileSync(join(dir, "status.json"), "utf8")) as AsyncStatus,
			result: JSON.parse(fs.readFileSync(resultFilePath(DIRS.results, runId), "utf8")) as Record<string, unknown> };
	}
	it("persists paused status/result/receipt without pretending review continued", async () => {
		const observed = await execute('await runs.run("worker", { agent: "worker", task: "approval" }); return runs.run("review", { agent: "reviewer", task: "review" });');
		expect(launches).toEqual(["worker"]);
		expect(observed.status).toMatchObject({ state: "paused", activityState: "needs_attention", steps: [expect.objectContaining({ workflowKey: "worker", status: "paused", activityState: "needs_attention" })] });
		expect(state.asyncJobs.get(observed.runId)?.status).toBe("paused");
		expect(observed.result).toMatchObject({ state: "paused", success: false, results: [expect.objectContaining({ workflowKey: "worker", detached: true, runId: "offline-child" })] });
		expect(readWorkflowReceipt(DIRS.async, observed.runId)).toMatchObject({ state: "paused", entries: { worker: { latestRunId: "offline-child" } } });
		// Settling the detached lane still cannot restore a JavaScript continuation.
		expect(reconcileDetachedWorkflowChildCompletion({ state, workflowRunId: observed.runId, childRunId: "offline-child", workflowKey: "worker",
			result: { index: 0, agent: "worker", task: "approval", exitCode: 0, messages: [], interrupted: false,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } } })).toBe(true);
		const settled = JSON.parse(fs.readFileSync(resultFilePath(DIRS.results, observed.runId), "utf8")) as Record<string, unknown>;
		expect(settled).toMatchObject({ state: "failed", success: false, workflowResolution: "settled-awaiting-resume" });
		expect(settled.summary).toContain("continuation was not persisted");
		expect(readWorkflowReceipt(DIRS.async, observed.runId).state).toBe("failed");
	}, 20000);
	it("does not misclassify a real failed sibling as a detached-only pause", async () => {
		realFailure = true;
		// runs.all deliberately collects failures. Re-observing the detached key
		// rejects with detached-child while the genuine failed sibling is retained.
		const observed = await execute('await runs.all([{ key: "worker", agent: "worker", task: "approval" }, { key: "review", agent: "reviewer", task: "review" }]); return runs.run("worker", { agent: "worker", task: "approval" });');
		expect(launches).toEqual(["worker", "review"]);
		expect(observed.status.state).toBe("failed");
		expect(observed.result).toMatchObject({ state: "failed", success: false });
		expect(readWorkflowReceipt(DIRS.async, observed.runId).state).toBe("failed");
		expect(observed.result.results).toHaveLength(2);
	}, 20000);
});
