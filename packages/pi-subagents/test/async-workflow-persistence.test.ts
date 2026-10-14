import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resultFilePath } from "../src/runs/background/result-files.ts";
import { createSubagentExecutor } from "../src/runs/foreground/subagent-executor.ts";
import { createRunFanoutBudget } from "../src/runs/shared/run-fanout-budget.ts";
import { DIRS, type AsyncStatus, type SubagentState } from "../src/shared/types.ts";
import * as workflow from "../src/workflows/scripted-workflow.ts";

const runWorkflowScript = workflow.runWorkflowScript;

describe("in-process async workflow persistence (source integration)", () => {
	const originalDirs = { ...DIRS };
	let directory: string;
	let budget: ReturnType<typeof createRunFanoutBudget>;
	let state: SubagentState;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-workflow-persistence-regression-"));
		Object.assign(DIRS, { async: join(directory, "async"), results: join(directory, "results"), chain: join(directory, "chain"), artifacts: join(directory, "artifacts") });
		budget = createRunFanoutBudget("offline-persistence-fixture", 4);
		state = { baseCwd: directory, currentSessionId: "offline-session", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
			cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} } };
		// Keep the real worker, script, and host persistence; runs.status answers offline.
		vi.spyOn(workflow, "runWorkflowScript").mockImplementation((options) => runWorkflowScript({ ...options,
			status: async (key) => ({ key, ok: false, output: `no run '${key}'`, artifactPaths: [] }),
		}));
	});

	afterEach(async () => {
		for (const controller of state.workflowControllers?.values() ?? []) controller.abort();
		await vi.waitFor(() => expect(state.workflowControllers?.size ?? 0).toBe(0), { timeout: 10000 });
		vi.restoreAllMocks();
		Object.assign(DIRS, originalDirs);
		fs.rmSync(directory, { recursive: true, force: true });
		fs.rmSync(budget.directory, { recursive: true, force: true });
	});

	async function launch(script: string): Promise<{ runId: string; dir: string }> {
		const ctx = { cwd: directory, hasUI: false, isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "offline-session", getSessionFile: () => join(directory, "parent.jsonl") } } as unknown as ExtensionContext;
		const executor = createSubagentExecutor({ pi: {} as ExtensionAPI, state, config: { artifactDir: "project" }, asyncByDefault: true,
			tempArtifactsDir: join(directory, "artifacts"), getSubagentSessionRoot: () => join(directory, "sessions"), expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }) });
		// A nested workflow (workflowParentRunId) skips the shared per-session capacity store.
		const receipt = await executor.execute("offline-parent-call", { workflowScript: script, async: true, mission: false, output: false,
			workflowParentRunId: "offline-parent", runFanoutBudget: budget }, new AbortController().signal, undefined, ctx);
		expect(receipt.isError).not.toBe(true);
		return { runId: receipt.details.asyncId!, dir: receipt.details.asyncDir! };
	}

	function readEvents(dir: string): Array<Record<string, unknown>> {
		return fs.readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("F2: keeps a finished workflow complete when its terminal status write fails", async () => {
		const unhandled: unknown[] = [];
		const recordUnhandled = (reason: unknown) => { unhandled.push(reason); };
		process.on("unhandledRejection", recordUnhandled);
		try {
			const { runId, dir } = await launch("return 1;");
			// The workflow runs in a Worker, so this lands before its terminal write: every later
			// status.json rename now fails with EISDIR, which is not a storage-capacity error.
			const statusPath = join(dir, "status.json");
			fs.rmSync(statusPath, { force: true });
			fs.mkdirSync(join(statusPath, "blocker"), { recursive: true });
			await vi.waitFor(() => expect(state.workflowControllers?.has(runId)).toBe(false), { timeout: 15000 });
			await new Promise((resolve) => setImmediate(resolve));

			expect(JSON.parse(fs.readFileSync(resultFilePath(DIRS.results, runId), "utf8"))).toMatchObject({ state: "complete", success: true });
			expect(state.asyncJobs.get(runId)?.status).toBe("complete");
			const events = readEvents(dir);
			expect(events.some((event) => event.type === "subagent.workflow.status_write_failed")).toBe(true);
			expect(events.at(-1)).toMatchObject({ type: "subagent.workflow.completed", state: "complete" });
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", recordUnhandled);
		}
	}, 30000);

	it("F4: journals each workflow trace entry once instead of the whole trace per change", async () => {
		const calls = 30;
		const { runId, dir } = await launch(`for (let i = 0; i < ${calls}; i++) { try { await runs.status("missing-" + i); } catch (error) {} }\nreturn 1;`);
		await vi.waitFor(() => expect(state.workflowControllers?.has(runId)).toBe(false), { timeout: 15000 });

		const status = JSON.parse(fs.readFileSync(join(dir, "status.json"), "utf8")) as AsyncStatus;
		expect(status.state).toBe("complete");
		const finalTrace = status.workflow?.trace ?? [];
		expect(finalTrace).toHaveLength(2 * calls);
		const traceEvents = readEvents(dir).filter((event) => event.type === "subagent.workflow.trace");
		expect(traceEvents).toHaveLength(2 * calls);
		const journaled = traceEvents.flatMap((event) => (event.entries ?? event.trace) as unknown[]);
		expect(journaled).toEqual(finalTrace);
		expect(traceEvents.map((event) => event.from)).toEqual(finalTrace.map((_entry, index) => index));
	}, 30000);
});
