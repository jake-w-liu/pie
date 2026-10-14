import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { updateActiveRunIndex } from "../src/runs/background/active-run-index.ts";
import { waitForSubagents } from "../src/runs/background/subagent-wait.ts";
import type { SubagentState } from "../src/shared/types.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Regression: a workflow child blocked in contact_supervisor did not end subagent_wait unless some
 * step was also flagged needs_attention, so the request expired unanswered while the parent waited.
 */
it.each([true, false])(
	"returns as soon as a child awaits a supervisor reply (stopOnAttention: %s)",
	async (stopOnAttention) => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-"));
		roots.push(base);
		const asyncRoot = path.join(base, "async");
		const resultsDir = path.join(base, "results");
		const sessionId = "/sessions/parent.jsonl";
		const runId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000042";
		const asyncDir = path.join(asyncRoot, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(resultsDir, { recursive: true });
		const now = Date.now();
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({
				runId,
				sessionId,
				mode: "workflow",
				state: "running",
				pid: process.pid,
				startedAt: now,
				lastUpdate: now,
				currentStep: 0,
				steps: [
					{ agent: "worker", status: "running", startedAt: now, activityState: "active_long_running", currentTool: "bash" },
					{
						agent: "worker",
						status: "running",
						startedAt: now,
						activityState: "active_long_running",
						currentTool: "contact_supervisor",
					},
				],
			}),
		);
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		updateActiveRunIndex(asyncDir, "running");

		let clock = 0;
		const result = await waitForSubagents({ id: runId, timeoutMs: 600_000, stopOnAttention }, undefined, {
			state: {
				currentSessionId: sessionId,
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				cleanupTimers: new Map(),
				completionSeen: new Map(),
			} as unknown as SubagentState,
			asyncDirRoot: asyncRoot,
			resultsDir,
			now: () => clock,
			pollIntervalMs: 1_000,
			sleep: async (ms) => {
				clock += ms;
			},
		});

		expect(clock).toBe(0);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("Reply to any pending supervisor request");
	},
);
