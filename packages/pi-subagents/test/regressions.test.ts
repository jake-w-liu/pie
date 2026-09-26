import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/agents/frontmatter.ts";
import { classifyTaskMutationIntent } from "../src/runs/shared/task-intent.ts";
import { matchesScopePattern } from "../src/runs/shared/model-scope.ts";

describe("quick audit fixes", () => {
	it("model-scope treats ? literally", () => {
		expect(matchesScopePattern("b", "a?b")).toBe(false);
		expect(matchesScopePattern("a?b", "a?b")).toBe(true);
		expect(matchesScopePattern("ab", "a?b")).toBe(false);
		expect(matchesScopePattern("openai/gpt-4o", "openai/gpt-4?")).toBe(false);
		expect(matchesScopePattern("openai/gpt-4?", "openai/gpt-4?")).toBe(true);
	});
	it("task-intent matches plural nouns", () => {
		expect(classifyTaskMutationIntent("worker", "Fix bugs").kind).toBe("implementation");
		expect(classifyTaskMutationIntent("worker", "Fix components").kind).toBe("implementation");
		expect(classifyTaskMutationIntent("worker", "Fix bug").kind).toBe("implementation");
	});
	it("frontmatter strips inline comments from unquoted scalars", () => {
		const parsed = parseFrontmatter("---\nname: x\ndescription: d # primary\ntools: read, grep # keep\nquoted: 'a # b'\nurl: http://x#y\n---\n");
		expect(parsed.frontmatter.description).toBe("d");
		expect(parsed.frontmatter.tools).toBe("read, grep");
		expect(parsed.frontmatter.quoted).toBe("a # b");
		expect(parsed.frontmatter.url).toBe("http://x#y");
	});
});

import { serializeAgent } from "../src/agents/agent-serializer.ts";
import type { AgentConfig } from "../src/agents/agents.ts";

function cfg(description: string): AgentConfig {
	return {
		name: "myagent",
		description,
		systemPrompt: "body",
		source: "runtime",
		filePath: "myagent.md",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
	} as unknown as AgentConfig;
}

describe("agent serializer description round-trip", () => {
	for (const description of ["first line\nsecond line", "a # b", "- leading dash", "plain", "say \"hi\"", "trailing space "]) {
		it(JSON.stringify(description), () => {
			const text = serializeAgent(cfg(description));
			const parsed = parseFrontmatter(text);
			expect(parsed.frontmatter.description).toBe(description);
		});
	}
});

import { quoteExecutableForShell } from "../src/runs/shared/acceptance.ts";

describe("quoteExecutableForShell (win32)", () => {
	it("quotes a spaced directory with an extensionless launcher", () => {
		expect(quoteExecutableForShell("C:\\Program Files\\my tool\\node script.js", "win32"))
			.toBe("\"C:\\Program Files\\my tool\\node\" script.js");
		expect(quoteExecutableForShell("C:\\Program Files\\my tool\\python -m pytest", "win32"))
			.toBe("\"C:\\Program Files\\my tool\\python\" -m pytest");
	});
	it("quotes correctly when an argument is quoted", () => {
		expect(quoteExecutableForShell("C:\\Program Files\\my tool\\node \"script.js\"", "win32"))
			.toBe("\"C:\\Program Files\\my tool\\node\" \"script.js\"");
	});
	it("quotes an exe in a spaced directory and keeps flags", () => {
		expect(quoteExecutableForShell("C:\\Program Files\\tool.exe --flag", "win32"))
			.toBe("\"C:\\Program Files\\tool.exe\" --flag");
	});
	it("passes through non-win32 and already-quoted commands", () => {
		expect(quoteExecutableForShell("C:\\Program Files\\node script.js", "darwin")).toBe("C:\\Program Files\\node script.js");
		expect(quoteExecutableForShell("\"C:\\Program Files\\node\" script.js", "win32")).toBe("\"C:\\Program Files\\node\" script.js");
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneForkSessionFile } from "../src/shared/pruned-fork.ts";

describe("pruned fork duplicate-text leak guard", () => {
	it("prunes when a spilled body also appears in a retained entry", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-audit-"));
		const file = path.join(dir, "session.jsonl");
		const body = "Z".repeat(40000);
		const entries = [
			{ type: "session", id: "h", parentSession: "/parent/session.jsonl" },
			{ type: "message", id: "t1", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: body }] } },
			{ type: "message", id: "t2", message: { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: body }] } },
		];
		fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const summarize = async (payload: string): Promise<string> => {
			const parsed = JSON.parse(payload) as { items: Array<{ itemId: string }> };
			return JSON.stringify({ summaries: parsed.items.map((item) => ({ itemId: item.itemId, summary: "condensed" })) });
		};
		await expect(pruneForkSessionFile(file, summarize)).resolves.toBe(true);
	});
});

import { createSteeringStatus, recordSteeringRequest, updateSteeringTarget } from "../src/runs/background/steering.ts";

describe("steering counters release the scheduled bucket", () => {
	it("scheduled -> routed -> delivered counts one target once", () => {
		const status = createSteeringStatus();
		recordSteeringRequest(status, { id: "req-1", requestedAt: 1, message: "hello", targets: [{ index: 0, state: "scheduled" }] });
		updateSteeringTarget(status, "req-1", 0, "routed", 2);
		expect({ scheduled: status.scheduled, pending: status.pending, delivered: status.delivered }).toEqual({ scheduled: 0, pending: 1, delivered: 0 });
		updateSteeringTarget(status, "req-1", 0, "delivered", 3);
		expect({ scheduled: status.scheduled, pending: status.pending, delivered: status.delivered }).toEqual({ scheduled: 0, pending: 0, delivered: 1 });
	});
	it("scheduled -> failed counts one target once", () => {
		const status = createSteeringStatus();
		recordSteeringRequest(status, { id: "req-2", requestedAt: 1, message: "hello", targets: [{ index: 0, state: "scheduled" }] });
		updateSteeringTarget(status, "req-2", 0, "failed", 2);
		expect({ scheduled: status.scheduled, failed: status.failed }).toEqual({ scheduled: 0, failed: 1 });
	});
});

import { cleanupAsyncRetention } from "../src/runs/background/async-retention.ts";

describe("async retention discovery fallback", () => {
	it("reclaims an aged terminal run without the optional worker asset", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-audit-"));
		const asyncDirRoot = path.join(root, "async");
		const resultsDir = path.join(root, "results");
		fs.mkdirSync(asyncDirRoot, { recursive: true });
		fs.mkdirSync(resultsDir, { recursive: true });
		const runId = "0198e6a1-1111-7000-8000-000000000000";
		const runDir = path.join(asyncDirRoot, runId);
		fs.mkdirSync(runDir);
		const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
		const statusPath = path.join(runDir, "status.json");
		fs.writeFileSync(statusPath, JSON.stringify({ runId, state: "complete", mode: "single", startedAt: old, endedAt: old, lastUpdate: old }));
		fs.utimesSync(runDir, old / 1000, old / 1000);
		fs.utimesSync(statusPath, old / 1000, old / 1000);
		const result = await cleanupAsyncRetention({ asyncDirRoot, resultsDir, now: () => Date.now() });
		expect(result.workerFailed).toBe(false);
		expect(result.deletedRuns).toBe(1);
		expect(fs.existsSync(runDir)).toBe(false);
	});
});

import { WatchdogEmissionGuard } from "../src/watchdog/emission-guard.ts";

const warn = (severity: "concern" | "blocker", summary: string) => ({
	severity,
	summary,
	evidence: `${summary} evidence`,
	recommendedAction: `address ${summary}`,
});

describe("watchdog emission guard update budget", () => {
	it("gives each independent review pass its own budget", () => {
		const guard = new WatchdogEmissionGuard();
		guard.startModelUpdate();
		expect(guard.evaluate(warn("concern", "lsp found something"))).toMatchObject({ accepted: true });
		guard.startModelUpdate();
		expect(guard.evaluate(warn("blocker", "model found a blocker"))).toMatchObject({ accepted: true });
	});
	it("lets a blocker displace an accepted concern within one update", () => {
		const guard = new WatchdogEmissionGuard();
		guard.startModelUpdate();
		expect(guard.evaluate(warn("concern", "first"))).toMatchObject({ accepted: true });
		expect(guard.evaluate(warn("blocker", "distinct blocker"))).toMatchObject({ accepted: true });
	});
	it("still drops a second distinct concern in the same update", () => {
		const guard = new WatchdogEmissionGuard();
		guard.startModelUpdate();
		expect(guard.evaluate(warn("concern", "first"))).toMatchObject({ accepted: true });
		expect(guard.evaluate(warn("concern", "second"))).toMatchObject({ accepted: false, reason: "update-budget" });
	});
});

import { evaluateAcceptance } from "../src/runs/shared/acceptance.ts";
import type { ResolvedAcceptanceConfig } from "../src/shared/types.ts";

function verifiedAcceptance(verify: ResolvedAcceptanceConfig["verify"]): ResolvedAcceptanceConfig {
	return { level: "verified", explicit: true, inferredReason: [], criteria: [], evidence: [], verify, stopRules: [] };
}

/** Build a verify command whose Node child writes the given expression to stdout. */
function emitStdoutCommand(cwd: string, expression: string): string {
	const script = path.join(cwd, "emit-stdout.mjs");
	fs.writeFileSync(script, `process.stdout.write(${expression});\n`, "utf-8");
	return `${process.execPath} ${JSON.stringify(script)}`;
}

describe("acceptance verify output capture", () => {
	it("caps runaway verify output and reports the dropped byte count", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cap-audit-"));
		const ledger = await evaluateAcceptance({
			acceptance: verifiedAcceptance([{ id: "flood", command: emitStdoutCommand(cwd, '"x".repeat(300000)') }]),
			output: "",
			cwd,
			reportOptional: true,
		});
		const stdout = ledger.verifyRuns[0]?.stdout ?? "";
		expect(stdout.startsWith("[verify output truncated at 131072 bytes; 168928 further byte(s) not captured]\n")).toBe(true);
		expect(stdout).toContain("x");
		expect(stdout.length).toBeLessThanOrEqual(12_000 + "\n...[truncated]".length);
	}, 30_000);

	it("never decodes a half-captured multi-byte character at the cap boundary", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-utf8-audit-"));
		const ledger = await evaluateAcceptance({
			acceptance: verifiedAcceptance([{ id: "euro", command: emitStdoutCommand(cwd, '"€".repeat(200000)') }]),
			output: "",
			cwd,
			reportOptional: true,
		});
		const stdout = ledger.verifyRuns[0]?.stdout ?? "";
		expect(stdout).toContain("€");
		expect(stdout.includes("\uFFFD")).toBe(false);
		// 200_000 three-byte characters: 600_000 bytes emitted, 131_072 retained.
		expect(stdout.startsWith("[verify output truncated at 131072 bytes; 468928 further byte(s) not captured]\n")).toBe(true);
	}, 30_000);

	it("leaves ordinary verify output untouched", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-plain-audit-"));
		const ledger = await evaluateAcceptance({
			acceptance: verifiedAcceptance([{ id: "ok", command: emitStdoutCommand(cwd, '"hello verify"') }]),
			output: "",
			cwd,
			reportOptional: true,
		});
		expect(ledger.verifyRuns[0]?.status).toBe("passed");
		expect(ledger.verifyRuns[0]?.stdout).toBe("hello verify");
	}, 30_000);
});

import { loadRunsForAgent, recordRun } from "../src/runs/shared/run-history.ts";

describe("run history file writes", () => {
	function withAgentDir(fn: (dir: string) => void): void {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-history-audit-"));
		const pieDir = process.env.PIE_CODING_AGENT_DIR;
		const piDir = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PIE_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			fn(dir);
		} finally {
			if (pieDir === undefined) delete process.env.PIE_CODING_AGENT_DIR;
			else process.env.PIE_CODING_AGENT_DIR = pieDir;
			if (piDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = piDir;
		}
	}

	function historyPath(dir: string): string {
		return path.join(dir, "run-history.jsonl");
	}

	function seedLegacyHistory(dir: string, count: number): void {
		const lines = Array.from({ length: count }, (_unused, index) => JSON.stringify({
			agent: "worker",
			task: `legacy task ${index}`,
			ts: index,
			status: "ok",
			duration: 1,
		}));
		fs.writeFileSync(historyPath(dir), `${lines.join("\n")}\n`);
	}

	it("records a run and reads it back", () => {
		withAgentDir((dir) => {
			recordRun("worker", "do the thing", 0, 5);
			const runs = loadRunsForAgent("worker");
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({ agent: "worker", task: "[redacted]", status: "ok" });
		});
	});

	it("a read never rewrites the file", () => {
		withAgentDir((dir) => {
			seedLegacyHistory(dir, 1300);
			const before = fs.readFileSync(historyPath(dir), "utf-8");
			expect(loadRunsForAgent("worker")).toHaveLength(1300);
			expect(fs.readFileSync(historyPath(dir), "utf-8")).toBe(before);
		});
	});

	it("the writer sanitizes and rotates without leaving temp files", () => {
		withAgentDir((dir) => {
			seedLegacyHistory(dir, 1300);
			recordRun("worker", "newest", 0, 5);
			const lines = fs.readFileSync(historyPath(dir), "utf-8").trim().split("\n");
			// 1000 retained legacy lines plus the newly appended run.
			expect(lines).toHaveLength(1001);
			expect(lines.every((line) => (JSON.parse(line) as { task: string }).task === "[redacted]")).toBe(true);
			expect(fs.readdirSync(dir)).toEqual(["run-history.jsonl"]);
		});
	});

	it("keeps the file bounded across many single-writer appends", () => {
		withAgentDir((dir) => {
			seedLegacyHistory(dir, 1300);
			let peak = 0;
			for (let index = 0; index < 500; index++) {
				recordRun("worker", `task ${index}`, 0, 1);
				const count = fs.readFileSync(historyPath(dir), "utf-8").trim().split("\n").length;
				peak = Math.max(peak, count);
			}
			// The rotate threshold plus the one line appended after the rewrite.
			expect(peak).toBeLessThanOrEqual(1201);
			const lines = fs.readFileSync(historyPath(dir), "utf-8").trim().split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(1001);
			expect(lines.every((line) => (JSON.parse(line) as { task: string }).task === "[redacted]")).toBe(true);
		});
	}, 30_000);
});
