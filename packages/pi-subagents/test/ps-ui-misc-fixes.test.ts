import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HerdrClient, HerdrResult } from "../src/inspectors/herdr/client.ts";
import { handleHerdrInspectorAction } from "../src/inspectors/herdr/actions.ts";
import { handleMissionAction } from "../src/missions/actions.ts";
import { attachMissionToLaunchResult, syncMissionFromAsyncCompletion, writeMissionAsyncBinding } from "../src/missions/lifecycle.ts";
import { createMission, readMission, resolveMissionStoreLocation, updateMission } from "../src/missions/store.ts";
import { readFleetTranscript, readFleetTranscriptIncrementally, renderFleetTranscript, type FleetTranscript } from "../src/tui/fleet-transcript.ts";
import { renderFleetTranscriptIncrementally } from "../src/tui/fleet.ts";
import { createRunFanoutBudget } from "../src/runs/shared/run-fanout-budget.ts";
import { collectWatchdogLspDiagnostics, WatchdogLspDiagnosticsLedger } from "../src/watchdog/lsp-diagnostics.ts";

const runnerPath = fileURLToPath(new URL("../src/runs/background/subagent-runner.ts", import.meta.url));

async function runBackgroundRunner(config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<void> {
	const configPath = path.join(path.dirname(config.asyncDir as string), "runner-config.json");
	fs.writeFileSync(configPath, JSON.stringify(config));
	const child = spawn(process.execPath, [runnerPath, configPath], {
		cwd: config.cwd as string,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`runner exited ${code}: ${stderr}`)));
	});
}

describe("mission lifecycle regressions", () => {
	it("counts cache tokens emitted by the canonical async producer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-async-usage-"));
		const location = resolveMissionStoreLocation({ projectRoot: root, config: { directory: path.join(root, "missions"), globalIndex: false } });
		const usage = { input: 20_000, output: 5_000, cacheRead: 500_000, cacheWrite: 0, cost: 0, turns: 1 };
		const foreground = createMission(location, { title: "foreground", objective: "goal", goal: true, budget: { tokens: 100_000 }, status: "active" });
		attachMissionToLaunchResult({
			binding: { missionId: foreground.id, location, autoCreated: false },
			result: {
				content: [{ type: "text", text: "done" }],
				details: { mode: "single", runId: "foreground-run", results: [{ index: 0, agent: "worker", task: "task", exitCode: 0, messages: [], usage }] },
			},
		});
		const mission = createMission(location, { title: "async", objective: "goal", goal: true, budget: { tokens: 100_000 }, status: "active" });
		const asyncDir = path.join(root, "async");
		const resultsDir = path.join(root, "results");
		const cwd = path.join(root, "cwd");
		const home = path.join(root, "home");
		for (const directory of [asyncDir, resultsDir, cwd, home]) fs.mkdirSync(directory, { recursive: true });
		const fakePi = path.join(root, "fake-pi.mjs");
		fs.writeFileSync(fakePi, `#!/usr/bin/env node
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "fake/model", usage: { input: 20000, output: 5000, cacheRead: 500000, cacheWrite: 0, cost: { total: 0 } } } });
`);
		fs.chmodSync(fakePi, 0o755);
		const resultPath = path.join(resultsDir, "run-1.json");
		await runBackgroundRunner({
			id: "run-1",
			mode: "single",
			steps: [{ task: "go", agent: "worker", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }],
			resultPath,
			cwd,
			placeholder: "{previous}",
			asyncDir,
			sessionId: "session-1",
			runnerProcessInstanceId: "runner-process-1",
			runFanoutBudget: createRunFanoutBudget("run-1", 50),
		}, { HOME: home, PI_SUBAGENT_PI_BINARY: fakePi });
		const emitted = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as Record<string, unknown> & { totalCost?: Record<string, number>; results?: Array<{ totalCost?: Record<string, number> }> };
		expect(emitted.totalCost).toMatchObject({ inputTokens: 20_000, outputTokens: 5_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 });
		expect(emitted.results?.[0]?.totalCost).toMatchObject({ cacheReadTokens: 500_000, cacheWriteTokens: 0 });

		writeMissionAsyncBinding(asyncDir, { missionId: mission.id, location, autoCreated: false });
		syncMissionFromAsyncCompletion(emitted);

		const foregroundUpdated = readMission(location, foreground.id);
		const updated = readMission(location, mission.id);
		expect(updated.usage?.tokens).toBe(foregroundUpdated.usage?.tokens);
		expect(updated.usage?.tokens).toBe(525_000);
		expect(foregroundUpdated.goal?.status).toBe("budget-exhausted");
		expect(updated.goal?.status).toBe("budget-exhausted");

		const legacy = createMission(location, { title: "legacy async", objective: "goal", goal: true, budget: { tokens: 100_000 }, status: "active" });
		writeMissionAsyncBinding(asyncDir, { missionId: legacy.id, location, autoCreated: false });
		syncMissionFromAsyncCompletion({
			...emitted,
			runId: "legacy-run",
			totalCost: { inputTokens: 20_000, outputTokens: 5_000, costUsd: 0 },
		});
		expect(readMission(location, legacy.id).usage?.tokens).toBe(525_000);
	});

	it("preserves needs_decision during mission.show and async completion refresh", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-decision-"));
		const config = { directory: path.join(root, "missions"), globalIndex: false };
		const location = resolveMissionStoreLocation({ projectRoot: root, config });
		const asyncDir = path.join(root, "async");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "running" }));
		const mission = createMission(location, { title: "goal", objective: "goal", goal: true, budget: { tokens: 100_000 }, status: "active" });
		updateMission(location, mission.id, { addRuns: [{ runId: "run-1", mode: "single", asyncDir, status: "running" }] });
		expect(updateMission(location, mission.id, { addDecisions: [{ title: "Pick" }] }).status).toBe("needs_decision");

		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }));
		handleMissionAction("mission.show", { missionId: mission.id }, { cwd: root, config });
		expect(readMission(location, mission.id).status).toBe("needs_decision");

		writeMissionAsyncBinding(asyncDir, { missionId: mission.id, location, autoCreated: false });
		syncMissionFromAsyncCompletion({ runId: "run-1", asyncDir, mode: "single", state: "complete", success: true });
		expect(readMission(location, mission.id).status).toBe("needs_decision");
	});
});

describe("LSP transport regression", () => {
	it("returns failed instead of crashing when the server closes stdin during didOpen", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-epipe-"));
		const binDir = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(root, "big.ts"), `export const value = "${"x".repeat(4_000_000)}";\n`);
		const server = path.join(binDir, "typescript-language-server");
		fs.writeFileSync(server, `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
 buffer = Buffer.concat([buffer, chunk]);
 const end = buffer.indexOf("\\r\\n\\r\\n");
 if (end < 0) return;
 const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
 if (buffer.length < end + 4 + length) return;
 const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
 const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
 process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`, () => process.exit(0));
});
`);
		fs.chmodSync(server, 0o755);

		const result = await collectWatchdogLspDiagnostics({
			cwd: root,
			root,
			changedPaths: ["big.ts"],
			// The transport error must surface before the client's own deadline, so give
			// the write to the dead server room to fail under load instead of racing a
			// short timeout that reports "timeout" for the same dead transport.
			config: { enabled: true, timeoutMs: 8_000, maxFiles: 5, maxDiagnostics: 50 },
		});
		expect(result.status).toBe("failed");
	}, 20_000);

	it("reports a server that exits after initialize as failed without waiting out the deadline", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-exit-"));
		const binDir = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(root, "small.ts"), "export const value = 1;\n");
		const server = path.join(binDir, "typescript-language-server");
		// Answers initialize, keeps reading (so every notification is written), then exits
		// without ever publishing diagnostics.
		fs.writeFileSync(server, `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
let answered = false;
process.stdin.on("data", (chunk) => {
 buffer = Buffer.concat([buffer, chunk]);
 if (answered) return;
 const end = buffer.indexOf("\\r\\n\\r\\n");
 if (end < 0) return;
 const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
 if (buffer.length < end + 4 + length) return;
 const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
 answered = true;
 const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
 process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`);
 setTimeout(() => process.exit(0), 300);
});
`);
		fs.chmodSync(server, 0o755);
		try {
			const started = Date.now();
			const result = await collectWatchdogLspDiagnostics({
				cwd: root,
				root,
				changedPaths: ["small.ts"],
				config: { enabled: true, timeoutMs: 15_000, maxFiles: 5, maxDiagnostics: 50 },
			});
			expect(result.status).toBe("failed");
			expect(result.message).toContain("language server exited");
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps the diagnostics a server published before it died", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-partial-"));
		const binDir = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(root, "a.ts"), "export const a: number = 'x';\n");
		fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");
		const server = path.join(binDir, "typescript-language-server");
		// Publishes diagnostics for a.ts, then exits once it has read the last notification (the
		// didSave for b.ts) and flushed its output, so b.ts never gets diagnostics.
		fs.writeFileSync(server, `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
const send = (message) => {
 const body = JSON.stringify(message);
 process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`);
};
process.stdin.on("data", (chunk) => {
 buffer = Buffer.concat([buffer, chunk]);
 while (true) {
  const end = buffer.indexOf("\\r\\n\\r\\n");
  if (end < 0) return;
  const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
  if (buffer.length < end + 4 + length) return;
  const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
  buffer = buffer.subarray(end + 4 + length);
  const uri = message.params?.textDocument?.uri ?? "";
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  if (message.method === "textDocument/didOpen" && uri.endsWith("/a.ts")) {
   send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, severity: 1, code: 2322, source: "typescript", message: "Type 'string' is not assignable to type 'number'." }] } });
  }
  if (message.method === "textDocument/didSave" && uri.endsWith("/b.ts")) process.stdout.write("", () => process.exit(1));
 }
});
`);
		fs.chmodSync(server, 0o755);
		try {
			const result = await collectWatchdogLspDiagnostics({
				cwd: root,
				root,
				changedPaths: ["a.ts", "b.ts"],
				// Generous: the server dies on its own, so the deadline only bounds a stuck run.
				config: { enabled: true, timeoutMs: 20_000, maxFiles: 5, maxDiagnostics: 50 },
			});
			expect(result.status).toBe("failed");
			expect(result.message).toContain("language server exited with code 1");
			expect(result.diagnostics).toEqual([
				{
					path: "a.ts",
					line: 1,
					column: 14,
					severity: "error",
					source: "typescript",
					code: "2322",
					message: "Type 'string' is not assignable to type 'number'.",
				},
			]);
			// Reported once, like the partial result of a timeout.
			const ledger = new WatchdogLspDiagnosticsLedger();
			expect(ledger.reduce(result).diagnostics).toHaveLength(1);
			expect(ledger.reduce(result).diagnostics).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 45_000);
});

describe("Herdr inspector startup regression", () => {
	it("does not split a pane when the inspector runner is missing", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-runner-"));
		const runDir = path.join(root, "run-1");
		fs.mkdirSync(runDir);
		fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ runId: "run-1", state: "running", mode: "single", cwd: root, startedAt: Date.now(), steps: [] }));
		const calls: string[][] = [];
		const client: HerdrClient = {
			async run<T = unknown>(args: string[]): Promise<HerdrResult<T>> {
				calls.push(args);
				if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" as T };
				return { ok: true, data: { pane: { id: "pane-new" } } as T };
			},
		};
		const result = await handleHerdrInspectorAction("inspector.open", { dir: runDir }, {
			cwd: root,
			asyncDirRoot: root,
			client,
			runnerPath: path.join(root, "missing-runner.ts"),
		});
		expect(result).toMatchObject({ isError: true });
		expect(calls.map((args) => args.slice(0, 2))).toEqual([["--version"]]);
	});
});

describe("watchdog settings concurrency regression", () => {
	it("preserves disjoint updates from concurrent processes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-settings-"));
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ padding: "x".repeat(5_000_000), subagents: { watchdog: {} } }));
		const worker = path.join(root, "worker.ts");
		const settingsUrl = new URL("../src/watchdog/settings.ts", import.meta.url).href;
		fs.writeFileSync(worker, `import * as fs from "node:fs";
process.env.PI_CODING_AGENT_DIR = process.argv[2];
const { writeWatchdogModelSettings } = await import(${JSON.stringify(settingsUrl)});
fs.writeFileSync(process.argv[4], "ready");
while (!fs.existsSync(process.argv[5])) {}
const kind = process.argv[3];
writeWatchdogModelSettings({ scope: "user", target: { kind }, model: \`provider/\${kind}\` });
`);
		const readyMain = path.join(root, "ready-main");
		const readyChildren = path.join(root, "ready-children");
		const go = path.join(root, "go");
		const children = [
			spawn(process.execPath, [worker, agentDir, "main", readyMain, go]),
			spawn(process.execPath, [worker, agentDir, "children", readyChildren, go]),
		];
		while (!fs.existsSync(readyMain) || !fs.existsSync(readyChildren)) await new Promise((resolve) => setTimeout(resolve, 5));
		fs.writeFileSync(go, "go");
		await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
			let stderr = "";
			child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
			child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
		})));
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(settings.subagents.watchdog.main.model).toBe("provider/main");
		expect(settings.subagents.watchdog.children.model).toBe("provider/children");
	}, 60_000);
});

describe("Fleet transcript incremental regressions", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;
	const identity = (text: string) => text;
	const markdownTheme = {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	} as never;

	it("renders appended events exactly like a whole-transcript render", () => {
		const transcript = (texts: string[]): FleetTranscript => ({
			path: "/tmp/transcript.jsonl",
			truncated: false,
			events: texts.map((text) => ({ kind: "user" as const, text })),
		});
		const render = (value: FleetTranscript): string[] => renderFleetTranscript(value, 80, theme, markdownTheme);
		const first = renderFleetTranscriptIncrementally(transcript(["one", "two"]), undefined, render);
		expect(first.body).toEqual(renderFleetTranscript(transcript(["one", "two"]), 80, theme, markdownTheme));
		const appendedTranscript = transcript(["one", "two", "three"]);
		const appended = renderFleetTranscriptIncrementally(appendedTranscript, first.cache, render);
		expect(appended.renderedEvents).toBe(1);
		expect(appended.body).toEqual(renderFleetTranscript(appendedTranscript, 80, theme, markdownTheme));
		expect(appended.body.filter((line) => line === "│")).toHaveLength(2);
	});

	it("reads and parses only appended transcript records after the initial capped tail", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-incremental-read-"));
		const transcriptPath = path.join(root, "transcript.jsonl");
		const line = (index: number) => JSON.stringify({ recordType: "message", role: index % 2 ? "assistant" : "user", text: `message-${index}-${"x".repeat(2_000)}` });
		fs.writeFileSync(transcriptPath, Array.from({ length: 300 }, (_, index) => line(index)).join("\n") + "\n");
		const options = { trustedRoots: [root], maxRecords: 240, maxBytes: 2 * 1024 * 1024 };
		const first = readFleetTranscriptIncrementally(transcriptPath, options);
		expect(first.parsedRecords).toBeGreaterThan(200);
		const appendedLine = `${line(300)}\n`;
		fs.appendFileSync(transcriptPath, appendedLine);
		const appended = readFleetTranscriptIncrementally(transcriptPath, options, first.cache);
		expect(appended.bytesRead).toBe(Buffer.byteLength(appendedLine));
		expect(appended.parsedRecords).toBe(1);
		expect(appended.transcript).toEqual(readFleetTranscript(transcriptPath, options));
	});
});
