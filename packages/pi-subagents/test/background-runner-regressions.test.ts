import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeChainAppendInbox, enqueueChainAppendRequest } from "../src/runs/background/chain-append.ts";
import { waitForImportedAsyncRoot } from "../src/runs/background/chain-root-attachment.ts";
import { buildInspectReply } from "../src/runs/background/inspect-rpc.ts";
import { finalizeProcessTerminal } from "../src/runs/background/process-terminal.ts";
import { createRunFanoutBudget } from "../src/runs/shared/run-fanout-budget.ts";
import type { SubagentState } from "../src/shared/types.ts";

const runnerPath = fileURLToPath(new URL("../src/runs/background/subagent-runner.ts", import.meta.url));
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-runner-test-"));
	temporaryRoots.push(root);
	return root;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value));
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

async function runRunner(config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<number | null> {
	const configPath = path.join(path.dirname(config.asyncDir as string), "runner-config.json");
	writeJson(configPath, config);
	const child = spawn(process.execPath, [runnerPath, configPath], {
		cwd: config.cwd as string,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	return await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) reject(new Error(`runner exited ${code}: ${stderr}`));
			else resolve(code);
		});
	});
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("background runner regressions", () => {
	it("inspects a failed child while its parallel sibling is still running", () => {
		const root = temporaryRoot();
		const asyncRoot = path.join(root, "async");
		const asyncDir = path.join(asyncRoot, "parallel-run");
		const resultsDir = path.join(root, "results");
		const now = Date.now();
		writeJson(path.join(asyncDir, "status.json"), {
			runId: "parallel-run",
			sessionId: "session-1",
			mode: "parallel",
			state: "running",
			pid: process.pid,
			startedAt: now,
			lastUpdate: now,
			steps: [
				{ agent: "failed-child", status: "failed", error: "tool budget reached", exitCode: 1 },
				{ agent: "running-child", status: "running" },
			],
		});
		fs.mkdirSync(resultsDir, { recursive: true });
		const reply = buildInspectReply({ requestId: "request-1", asyncId: "parallel-run", childId: "step:0" }, {
			asyncDirRoot: asyncRoot,
			resultsDir,
			kill: () => true,
			state: {
				currentSessionId: "session-1",
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				foregroundRuns: new Map(),
				trustedSessionRoots: [],
			} as unknown as SubagentState,
		});
		expect(reply.error).toBeUndefined();
		expect(reply.finalOutput).toBe("tool budget reached");
	});

	it("rejects an append admitted after the runner closes its inbox without orphaning it", () => {
		const root = temporaryRoot();
		const asyncDir = path.join(root, "async", "chain-run");
		const statusPath = path.join(asyncDir, "status.json");
		writeJson(statusPath, {
			runId: "chain-run",
			mode: "chain",
			state: "running",
			startedAt: Date.now(),
			steps: [{ agent: "first", status: "running" }],
		});
		const step = { agent: "appended", task: "continue", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
		expect(() => enqueueChainAppendRequest({
			asyncDir,
			runId: "chain-run",
			steps: [step],
			admit: (persist) => {
				closeChainAppendInbox(asyncDir);
				writeJson(statusPath, { runId: "chain-run", mode: "chain", state: "complete", startedAt: Date.now(), steps: [{ agent: "first", status: "complete" }] });
				persist();
			},
		})).toThrow("append inbox is closed");
		expect(fs.readdirSync(path.join(asyncDir, "append-requests"))).toEqual([]);
	});

	it("waits for the run result when the attached child finishes before a sibling", async () => {
		const root = temporaryRoot();
		const asyncDir = path.join(root, "async", "parallel-run");
		const resultPath = path.join(root, "results", "parallel-run.json");
		writeJson(path.join(asyncDir, "status.json"), {
			runId: "parallel-run",
			mode: "parallel",
			state: "running",
			startedAt: Date.now(),
			steps: [{ agent: "slow", status: "running" }, { agent: "fast", status: "complete", exitCode: 0 }],
		});
		const timer = setTimeout(() => writeJson(resultPath, {
			runId: "parallel-run",
			state: "complete",
			success: true,
			results: [{ agent: "slow", output: "slow" }, { agent: "fast", output: "fast output", success: true }],
		}), 100);
		const result = await waitForImportedAsyncRoot({ runId: "parallel-run", asyncDir, resultPath, index: 1 }, {
			pollIntervalMs: 5,
			terminalResultGraceMs: 20,
		});
		clearTimeout(timer);
		expect(result).toMatchObject({ agent: "fast", output: "fast output", success: true, exitCode: 0 });
	});

	it("keeps zero-item dynamic results aligned with following steps", async () => {
		const root = temporaryRoot();
		const asyncDir = path.join(root, "async", "dynamic-run");
		const resultsDir = path.join(root, "results");
		const cwd = path.join(root, "cwd");
		const home = path.join(root, "home");
		const markDir = path.join(root, "marks");
		for (const directory of [asyncDir, resultsDir, cwd, home, markDir]) fs.mkdirSync(directory, { recursive: true });
		const fakePi = path.join(root, "fake-pi.mjs");
		fs.writeFileSync(fakePi, `#!/usr/bin/env node\nimport * as fs from "node:fs";\nconst out = value => process.stdout.write(JSON.stringify(value) + "\\n");\nconst n = fs.readdirSync(process.env.FAKE_PI_MARK_DIR).length;\nfs.writeFileSync(process.env.FAKE_PI_MARK_DIR + "/child-" + n, "");\nconst capture = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;\nif (capture) {\n out({ type: "tool_execution_start", toolCallId: "structured", toolName: "structured_output", args: { items: [] } });\n fs.writeFileSync(capture, JSON.stringify({ items: [] }));\n out({ type: "tool_execution_end", toolCallId: "structured", toolName: "structured_output" });\n out({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "structured", toolName: "structured_output", content: [{ type: "text", text: "ok" }] } });\n}\nout({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "output-" + n }], stopReason: "stop", model: "fake/model" } });\n`);
		fs.chmodSync(fakePi, 0o755);
		const base = { task: "go", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
		const resultPath = path.join(resultsDir, "dynamic-run.json");
		const exitCode = await runRunner({
			id: "dynamic-run",
			mode: "chain",
			resultMode: "chain",
			steps: [
				{ ...base, agent: "planner", outputName: "plan", structured: true, structuredOutputSchema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } },
				{ expand: { from: { output: "plan", path: "/items" }, maxItems: 5 }, parallel: { ...base, agent: "worker", task: "do {item}" }, collect: { as: "collected" } },
				{ ...base, agent: "finisher" },
			],
			resultPath,
			cwd,
			placeholder: "{previous}",
			asyncDir,
			sessionId: "session-1",
			runnerProcessInstanceId: "runner-process-1",
			runFanoutBudget: createRunFanoutBudget("dynamic-run", 50),
			dynamicFanoutMaxItems: 5,
		}, { HOME: home, FAKE_PI_MARK_DIR: markDir, PI_SUBAGENT_PI_BINARY: fakePi });
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { results: Array<{ agent: string; output: string }> };
		const candidate = JSON.parse(fs.readFileSync(path.join(asyncDir, "process-terminal-candidate.json"), "utf-8")) as { expectedWriters: Record<string, number> };
		expect(result.results.map(({ agent, output }) => [agent, output])).toEqual([
			["planner", "output-0"],
			["worker", "Dynamic fanout produced 0 results."],
			["finisher", "output-1"],
		]);
		expect(candidate.expectedWriters).toEqual({ "0": 1, "1": 0, "2": 1 });
		finalizeProcessTerminal(asyncDir, "dynamic-run", { processInstanceId: "runner-process-1", closeObservedAt: Date.now(), exitCode, signal: null });
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { steps: Array<{ processTerminal?: { state: string } }> };
		expect(status.steps.map((step) => step.processTerminal?.state)).toEqual(["observed", "not-started", "observed"]);
	}, 20_000);

	it.each([
		{ cacheKind: "read", cacheRead: 100, cacheWrite: 0 },
		{ cacheKind: "write", cacheRead: 0, cacheWrite: 100 },
	])("counts a finished parallel child's cache-$cacheKind usage before admitting the next child", async ({ cacheRead, cacheWrite }) => {
		const root = temporaryRoot();
		const asyncDir = path.join(root, "async", "cache-budget-run");
		const resultsDir = path.join(root, "results");
		const cwd = path.join(root, "cwd");
		const home = path.join(root, "home");
		const markDir = path.join(root, "marks");
		for (const directory of [asyncDir, resultsDir, cwd, home, markDir]) fs.mkdirSync(directory, { recursive: true });
		const fakePi = path.join(root, "fake-pi.mjs");
		fs.writeFileSync(fakePi, `#!/usr/bin/env node\nimport * as fs from "node:fs";\nconst marks = process.env.FAKE_PI_MARK_DIR;\nconst n = fs.readdirSync(marks).length;\nfs.writeFileSync(marks + "/started-" + n, "");\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "fake/model", usage: { input: 0, output: 0, cacheRead: ${cacheRead}, cacheWrite: ${cacheWrite}, cost: { total: 0 } } } }));\n`);
		fs.chmodSync(fakePi, 0o755);
		const step = (agent: string) => ({ agent, task: "go", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false });
		const resultPath = path.join(resultsDir, "cache-budget-run.json");
		await runRunner({
			id: "cache-budget-run",
			mode: "parallel",
			resultMode: "parallel",
			steps: [{ parallel: [step("first"), step("second")], concurrency: 1 }],
			resultPath,
			cwd,
			placeholder: "{previous}",
			asyncDir,
			sessionId: "session-1",
			usageBudget: { tokens: { hard: 10 } },
		}, { HOME: home, FAKE_PI_MARK_DIR: markDir, PI_SUBAGENT_PI_BINARY: fakePi });
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
			results: Array<{ agent: string; skipped?: boolean; error?: string; totalCost?: { cacheReadTokens?: number; cacheWriteTokens?: number } }>;
		};
		expect(fs.readdirSync(markDir)).toEqual(["started-0"]);
		expect(result.results[0]).toMatchObject({ agent: "first", totalCost: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } });
		expect(result.results[1]).toMatchObject({
			agent: "second",
			skipped: true,
			error: "Usage budget exhausted: reported tokens 100 reached hard limit 10.",
		});
	}, 20_000);

	it("tracks and clears blocking tools for appended steps", async () => {
		const root = temporaryRoot();
		const asyncDir = path.join(root, "async", "append-run");
		const resultsDir = path.join(root, "results");
		const cwd = path.join(root, "cwd");
		const home = path.join(root, "home");
		const markDir = path.join(root, "marks");
		for (const directory of [asyncDir, resultsDir, cwd, home, markDir]) fs.mkdirSync(directory, { recursive: true });
		const fakePi = path.join(root, "fake-pi.mjs");
		fs.writeFileSync(fakePi, `#!/usr/bin/env node\nimport * as fs from "node:fs";\nconst marks = process.env.FAKE_PI_MARK_DIR;\nconst n = fs.readdirSync(marks).filter(name => name.startsWith("started-")).length;\nconst out = value => process.stdout.write(JSON.stringify(value) + "\\n");\nfs.writeFileSync(marks + "/started-" + n, "");\nout({ type: "tool_execution_start", toolCallId: "call-" + n, toolName: "contact_supervisor", args: { reason: "need_decision" } });\nawait new Promise(resolve => setTimeout(resolve, 400));\nout({ type: "tool_execution_end", toolCallId: "call-" + n, toolName: "contact_supervisor" });\nout({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "call-" + n, toolName: "contact_supervisor", content: [{ type: "text", text: "ok" }] } });\nfs.writeFileSync(marks + "/closed-" + n, "");\nawait new Promise(resolve => setTimeout(resolve, 300));\nout({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "fake/model" } });\n`);
		fs.chmodSync(fakePi, 0o755);
		const step = (agent: string) => ({ agent, task: "go", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false });
		const run = runRunner({ id: "append-run", mode: "chain", resultMode: "chain", steps: [step("first")], resultPath: path.join(resultsDir, "append-run.json"), cwd, placeholder: "{previous}", asyncDir, sessionId: "session-1" }, {
			HOME: home,
			FAKE_PI_MARK_DIR: markDir,
			PI_SUBAGENT_PI_BINARY: fakePi,
		});
		const readStatus = (): { state: string; steps: Array<{ status: string; currentTool?: string; activityState?: string }> } | undefined => {
			try { return JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { state: string; steps: Array<{ status: string; currentTool?: string; activityState?: string }> }; } catch { return undefined; }
		};
		await waitFor(() => readStatus()?.steps[0]?.status === "running" ? true : undefined, "initial step");
		enqueueChainAppendRequest({ asyncDir, runId: "append-run", steps: [step("appended")] });
		await waitFor(() => readStatus()?.steps[1]?.currentTool === "contact_supervisor" ? true : undefined, "appended blocking tool");
		await waitFor(() => fs.existsSync(path.join(markDir, "closed-1")) && readStatus()?.steps[1]?.currentTool === undefined ? true : undefined, "appended tool close");
		await run;
		const final = readStatus();
		expect(final?.state).toBe("complete");
		expect(final?.steps[1]).toMatchObject({ status: "complete" });
		expect(final?.steps[1]?.currentTool).toBeUndefined();
		expect(final?.steps[1]?.activityState).toBeUndefined();
	}, 20_000);
});
