import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
it.each([
	{ stopOnAttention: true, blocks: true, returns: true },
	{ stopOnAttention: false, blocks: true, returns: true },
	// Status written before the flag existed: treated as blocking, as before.
	{ stopOnAttention: false, blocks: undefined, returns: true },
	// A progress update does not wait for a reply.
	{ stopOnAttention: false, blocks: false, returns: false },
])(
	"returns on a pending supervisor reply only (%o)",
	async ({ stopOnAttention, blocks, returns }) => {
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
						...(blocks === undefined ? {} : { currentToolBlocksSupervisor: blocks }),
					},
				],
			}),
		);
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		updateActiveRunIndex(asyncDir, "running");

		let clock = 0;
		const result = await waitForSubagents({ id: runId, timeoutMs: 5_000, stopOnAttention }, undefined, {
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

		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		if (returns) {
			expect(clock).toBe(0);
			expect(text).toContain("Reply to any pending supervisor request");
		} else {
			expect(clock).toBe(5_000);
			expect(text).toContain("Wait timed out");
		}
	},
);

/**
 * Regression: the background runner copied currentTool to the top-level status but not whether
 * it blocks on the supervisor, so a child's progress_update still ended subagent_wait.
 */
it("keeps waiting through a background child's progress update", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-progress-"));
	roots.push(root);
	const asyncRoot = path.join(root, "async");
	const asyncDir = path.join(asyncRoot, "wait-run");
	const resultsDir = path.join(root, "results");
	const cwd = path.join(root, "cwd");
	const home = path.join(root, "home");
	for (const dir of [asyncDir, resultsDir, cwd, home]) fs.mkdirSync(dir, { recursive: true });
	// A fake pi that sits in a non-blocking progress update for a few seconds.
	const fakePi = path.join(root, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`#!/usr/bin/env node
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "contact_supervisor", args: { reason: "progress_update", message: "halfway" } });
await new Promise((resolve) => setTimeout(resolve, 4000));
out({ type: "tool_execution_end", toolCallId: "call-1", toolName: "contact_supervisor" });
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "fake/model" } });
`,
	);
	fs.chmodSync(fakePi, 0o755);
	const configPath = path.join(asyncRoot, "runner-config.json");
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			id: "wait-run",
			mode: "chain",
			resultMode: "chain",
			steps: [{ agent: "worker", task: "go", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }],
			resultPath: path.join(resultsDir, "wait-run.json"),
			cwd,
			placeholder: "{previous}",
			asyncDir,
			sessionId: "session-1",
		}),
	);
	const runnerPath = fileURLToPath(new URL("../src/runs/background/subagent-runner.ts", import.meta.url));
	const runner = spawn(process.execPath, [runnerPath, configPath], {
		cwd,
		env: { ...process.env, HOME: home, PI_SUBAGENT_PI_BINARY: fakePi },
		stdio: ["ignore", "ignore", "ignore"],
	});
	const exited = new Promise((resolve) => runner.once("close", resolve));
	try {
		const readStatus = () => {
			try {
				return JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
					currentTool?: string;
					currentToolBlocksSupervisor?: boolean;
				};
			} catch {
				return undefined;
			}
		};
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && readStatus()?.currentTool !== "contact_supervisor") {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(readStatus()).toMatchObject({ currentTool: "contact_supervisor", currentToolBlocksSupervisor: false });

		const result = await waitForSubagents({ id: "wait-run", timeoutMs: 1_000, stopOnAttention: false }, undefined, {
			state: {
				currentSessionId: "session-1",
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				cleanupTimers: new Map(),
				completionSeen: new Map(),
			} as unknown as SubagentState,
			asyncDirRoot: asyncRoot,
			resultsDir,
			pollIntervalMs: 100,
		});
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("Wait timed out");
	} finally {
		await exited;
	}
}, 40_000);
