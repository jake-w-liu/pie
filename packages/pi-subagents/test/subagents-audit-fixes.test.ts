import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { handleManagementAction } from "../src/agents/agent-management.ts";
import { discoverAgentsAll, type AgentConfig } from "../src/agents/agents.ts";
import { SubagentParams } from "../src/extension/schemas.ts";
import { runSync } from "../src/runs/foreground/execution.ts";
import { resolveForegroundTimeout } from "../src/runs/foreground/subagent-executor.ts";
import { validateAcceptanceInput } from "../src/runs/shared/acceptance.ts";
import { createCodexExecJsonlParser } from "../src/runs/shared/codex-exec-adapter.ts";
import { buildModelCandidates, recordRetryableModelFailure, resolveSubagentModelOverride } from "../src/runs/shared/model-fallback.ts";
import { getExclusionsFilePath } from "../src/runs/shared/model-exclusions.ts";
import { buildTimeoutRecoverySummary, collectTrackedMutationEvidence, snapshotTrackedMutations } from "../src/runs/shared/mutation-evidence.ts";
import { createWorktrees, diffWorktrees } from "../src/runs/shared/worktree.ts";
import { cleanupOldArtifacts } from "../src/shared/artifacts.ts";
import { shortenPath } from "../src/shared/formatters.ts";
import { runWorkflowScript } from "../src/workflows/scripted-workflow.ts";

const roots: string[] = [];
const originalEnv = { ...process.env };
const ignoredChildPids: number[] = [];

// The model exclusion store is shared by every pie process unless redirected. It loads
// lazily, so pointing it at a private file here, before any test runs, keeps this file
// from reading or recording exclusions in the real store.
const exclusionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-audit-exclusions-"));
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(exclusionsRoot, "model-exclusions.json");
const isolatedEnv = { ...process.env };

afterEach(() => {
	for (const pid of ignoredChildPids.splice(0)) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	process.env = { ...isolatedEnv };
});

afterAll(() => {
	fs.rmSync(exclusionsRoot, { recursive: true, force: true });
	process.env = originalEnv;
});

function tempRoot(prefix: string): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	roots.push(root);
	return root;
}

/** Isolated HOME/agent dir plus a project root (`proj/.pi`) for agent management. */
function agentSandbox(): { root: string; project: string } {
	const root = tempRoot("pi-audit-agents-");
	process.env.HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home", ".pi", "agent");
	process.env.PI_OFFLINE = "1";
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	const project = path.join(root, "proj");
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	return { root, project };
}

const managementCtx = (cwd: string) => ({ cwd, modelRegistry: { getAvailable: () => [] } }) as never;
const resultText = (result: ReturnType<typeof handleManagementAction>) => (result.content[0] as { text: string }).text;

describe("subagents audit regressions", () => {
	it("C8: shortenPath only abbreviates paths inside the home directory", () => {
		process.env.HOME = "/Users/jake";
		expect(shortenPath("/Users/jake2/proj/out.md")).toBe("/Users/jake2/proj/out.md");
		expect(shortenPath("/Users/jake/proj/out.md")).toBe("~/proj/out.md");
		expect(shortenPath("/Users/jake")).toBe("~");
		process.env.HOME = "/Users/jake/";
		expect(shortenPath("/Users/jake/proj/out.md")).toBe("~/proj/out.md");
	});

	it("F5: reports a one-line reason when the cwd is not a git repository", () => {
		const root = tempRoot("pi-audit-nongit-");
		// Stop git from discovering a repository above the temp dir.
		process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
		const snapshot = snapshotTrackedMutations(root);
		expect(snapshot.unavailable).toBe("not a git repository");
		const summary = buildTimeoutRecoverySummary({ termination: "timed-out", evidence: collectTrackedMutationEvidence(snapshot) });
		expect(summary.message).toContain("- changed tracked files: unavailable (not a git repository)");
		expect(summary.message).not.toContain("usage: git");

		const emptyRepo = path.join(root, "empty");
		fs.mkdirSync(emptyRepo);
		execFileSync("git", ["init", "-q"], { cwd: emptyRepo });
		const unborn = snapshotTrackedMutations(emptyRepo).unavailable ?? "";
		expect(unborn).toMatch(/HEAD/);
		expect(unborn).not.toContain("\n");
		expect(unborn.length).toBeLessThanOrEqual(200);
	});

	it("C6: artifact retention removes expired files in nested artifact directories", () => {
		const root = tempRoot("pi-audit-artifacts-");
		const artifacts = path.join(root, "artifacts");
		const outside = path.join(root, "outside");
		const old = new Date(Date.now() - 30 * 86_400_000);
		const expired = [
			"run1_worker_output.md",
			"permission-audit/run1-0.jsonl",
			"worktree-diffs/run1/task-0-worker.patch",
			"outputs/run1/output.md",
			"acceptance/verify/run1/key.json",
		];
		for (const relative of [...expired, "progress/run2/progress.md"]) {
			const file = path.join(artifacts, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "x");
		}
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "keep.txt"), "x");
		fs.symlinkSync(outside, path.join(artifacts, "linked"));
		const setOld = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const entryPath = path.join(dir, entry.name);
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) setOld(entryPath);
				fs.utimesSync(entryPath, old, old);
			}
		};
		setOld(artifacts);
		fs.utimesSync(path.join(outside, "keep.txt"), old, old);
		// A live run still writing progress keeps its fresh file and its directory.
		fs.writeFileSync(path.join(artifacts, "progress/run2/progress.md"), "fresh");

		cleanupOldArtifacts(artifacts, 7);

		for (const relative of expired) expect(fs.existsSync(path.join(artifacts, relative)), relative).toBe(false);
		for (const emptied of ["permission-audit", "worktree-diffs", "outputs", "acceptance"]) {
			expect(fs.existsSync(path.join(artifacts, emptied)), emptied).toBe(false);
		}
		expect(fs.readFileSync(path.join(artifacts, "progress/run2/progress.md"), "utf-8")).toBe("fresh");
		expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf-8")).toBe("x");
	});

	it("C2: an agent created with turnBudget and toolBudget loads and can be updated", () => {
		const { project } = agentSandbox();
		const created = handleManagementAction("create", { action: "create", config: { name: "budgeted", description: "budget test", scope: "project", turnBudget: { maxTurns: 10 }, toolBudget: { hard: 5 } } }, managementCtx(project));
		expect(created.isError, resultText(created)).not.toBe(true);
		const discovered = discoverAgentsAll(project);
		expect(discovered.agentDiagnostics ?? []).toEqual([]);
		const agent = discovered.project.find((candidate) => candidate.name === "budgeted");
		expect(agent?.defaultTurnBudget).toMatchObject({ maxTurns: 10 });
		expect(agent?.toolBudget).toEqual({ hard: 5 });
		const updated = handleManagementAction("update", { action: "update", agent: "budgeted", config: { description: "updated" } }, managementCtx(project));
		expect(updated.isError, resultText(updated)).not.toBe(true);
		expect(discoverAgentsAll(project).project.find((candidate) => candidate.name === "budgeted")?.toolBudget).toEqual({ hard: 5 });
	});

	it("C3: updating an agent preserves unknown frontmatter values", () => {
		const { project } = agentSandbox();
		const file = path.join(project, ".pi", "agents", "styled.md");
		fs.writeFileSync(file, "---\nname: styled\ndescription: styled agent\ncolor: \"#ff8800\"\nnote: \"owner: platform team\"\npriority: 5\nmeta:\n  team: core\n  tier: 1\n---\n\nPrompt.\n");
		const before = discoverAgentsAll(project).project.find((agent) => agent.name === "styled")?.extraFields;
		expect(before).toEqual({ color: "#ff8800", note: "owner: platform team", priority: "5", meta: "team: core\ntier: 1" });

		const updated = handleManagementAction("update", { action: "update", agent: "styled", config: { description: "styled agent v2" } }, managementCtx(project));
		expect(updated.isError, resultText(updated)).not.toBe(true);

		const after = discoverAgentsAll(project);
		expect(after.agentDiagnostics ?? []).toEqual([]);
		expect(after.project.find((agent) => agent.name === "styled")?.extraFields).toEqual(before);
		// Values that already read back unchanged keep their original YAML form.
		const written = fs.readFileSync(file, "utf-8");
		expect(written).toContain("\npriority: 5\n");
		expect(written).toContain("\nmeta:\n  team: core\n  tier: 1\n");
	});

	it("C5: captures worktree patches larger than the spawnSync output buffer", () => {
		const root = tempRoot("pi-audit-worktree-");
		const repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
		git("init", "-q");
		git("config", "user.email", "audit@example.com");
		git("config", "user.name", "audit");
		fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
		git("add", "-A");
		git("commit", "-qm", "init");

		const setup = createWorktrees(repo, "big-diff-run", 1, { baseDir: path.join(root, "worktrees") });
		const content = `${"y".repeat(99)}\n`.repeat(12_000);
		fs.writeFileSync(path.join(setup.worktrees[0]!.path, "big.txt"), content);
		const [diff] = diffWorktrees(setup, ["worker"], path.join(root, "diffs"));

		expect(diff?.error).toBeUndefined();
		expect(diff?.filesChanged).toBe(1);
		expect(diff?.insertions).toBe(12_000);
		expect(fs.statSync(diff!.patchPath).size).toBeGreaterThan(content.length);
	});

	it("C1: codex error events do not end the turn", () => {
		const root = tempRoot("pi-audit-codex-");
		const finalMessagePath = path.join(root, "final-message.txt");
		const transient = createCodexExecJsonlParser(finalMessagePath);
		for (const event of [
			{ type: "thread.started", thread_id: "t1" },
			{ type: "turn.started" },
			{ type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion)" },
			{ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "final answer" } },
			{ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
		]) transient.parseLine(JSON.stringify(event));
		fs.writeFileSync(finalMessagePath, "final answer");
		expect(transient.finish()).toEqual({ state: "completed", output: "final answer" });

		const fatal = createCodexExecJsonlParser(finalMessagePath);
		fatal.parseLine(JSON.stringify({ type: "turn.started" }));
		fatal.parseLine(JSON.stringify({ type: "error", message: "unexpected status 401 Unauthorized: Missing bearer" }));
		fatal.parseLine(JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer" } }));
		expect(fatal.finish()).toEqual({ state: "failed", error: "unexpected status 401 Unauthorized: Missing bearer" });

		// A stream that ends after a fatal error without turn.failed still reports that error.
		const truncated = createCodexExecJsonlParser(finalMessagePath);
		truncated.parseLine(JSON.stringify({ type: "error", message: "stream closed" }));
		expect(truncated.finish()).toEqual({ state: "failed", error: "stream closed" });
	});

	it("C4: keeps the parent model when every candidate has a cached exclusion", () => {
		expect(getExclusionsFilePath()).toBe(path.join(exclusionsRoot, "model-exclusions.json"));
		const available = [
			{ provider: "audit-provider", id: "audit-model", fullId: "audit-provider/audit-model" },
			{ provider: "audit-other", id: "other-model", fullId: "audit-other/other-model" },
		];
		const primary = resolveSubagentModelOverride(undefined, { provider: "audit-provider", id: "audit-model" }, available);
		expect(primary).toBe("audit-provider/audit-model");
		recordRetryableModelFailure(primary, "429 Too Many Requests: rate limit exceeded");
		expect(buildModelCandidates(primary, undefined, available, undefined, { primaryModelFromParent: true })).toEqual(["audit-provider/audit-model"]);
		// A usable fallback is still preferred over an excluded primary.
		expect(buildModelCandidates(primary, ["audit-other/other-model"], available, undefined, { primaryModelFromParent: true })).toEqual(["audit-other/other-model"]);
	});

	it("F1: rejects timeouts that overflow a Node.js timer at every input boundary", async () => {
		const overflow = 3_000_000_000;
		expect(resolveForegroundTimeout({ timeoutMs: overflow }).error).toMatch(/no larger than 2147483647/);
		expect(resolveForegroundTimeout({ maxRuntimeMs: overflow }).error).toMatch(/no larger than 2147483647/);
		expect(resolveForegroundTimeout({ timeoutMs: 2_147_483_647 })).toEqual({ timeoutMs: 2_147_483_647 });
		expect(Value.Check(SubagentParams, { timeoutMs: overflow })).toBe(false);
		expect(Value.Check(SubagentParams, { maxRuntimeMs: overflow })).toBe(false);
		expect(Value.Check(SubagentParams, { timeoutMs: 2_147_483_647 })).toBe(true);
		expect(validateAcceptanceInput({ level: "verified", verify: [{ id: "slow", command: "sleep 1", timeoutMs: overflow }] }).join(" ")).toMatch(/timeoutMs must be an integer from 1 to 2147483647/);
		await expect(runWorkflowScript({
			script: "return 1;",
			timeoutMs: overflow,
			launch: async () => { throw new Error("unused"); },
			status: async () => { throw new Error("unused"); },
		})).rejects.toThrow(/no larger than 2147483647/);

		const { project } = agentSandbox();
		fs.writeFileSync(path.join(project, ".pi", "agents", "slow.md"), `---\nname: slow\ndescription: slow agent\ntimeoutMs: ${overflow}\n---\n\nPrompt.\n`);
		const discovered = discoverAgentsAll(project);
		expect(discovered.project.some((agent) => agent.name === "slow")).toBe(false);
		expect(discovered.agentDiagnostics?.map((diagnostic) => diagnostic.error).join(" ")).toMatch(/invalid timeoutMs frontmatter; expected a positive integer no larger than 2147483647/);
		const created = handleManagementAction("create", { action: "create", config: { name: "slow2", description: "slow", scope: "project", timeoutMs: overflow } }, managementCtx(project));
		expect(created.isError).toBe(true);
		expect(resultText(created)).toMatch(/config.timeoutMs must be a positive integer no larger than 2147483647/);
	});

	it("F3: an interrupted foreground child that ignores signals is killed within a bounded grace", async () => {
		const root = tempRoot("pi-audit-interrupt-");
		const home = path.join(root, "home");
		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		const pidFile = path.join(root, "child.pid");
		const fakePi = path.join(root, "fake-pi.mjs");
		// Mirrors a pi child whose graceful shutdown hangs: every later signal is a no-op.
		fs.writeFileSync(fakePi, [
			"#!/usr/bin/env node",
			"import * as fs from \"node:fs\";",
			"process.on(\"SIGINT\", () => {});",
			"process.on(\"SIGTERM\", () => {});",
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			"setInterval(() => {}, 1000);",
			"",
		].join("\n"));
		fs.chmodSync(fakePi, 0o755);
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
		process.env.PI_SUBAGENT_PI_BINARY = fakePi;
		const agent: AgentConfig = {
			name: "worker",
			description: "test",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			systemPrompt: "",
			source: "user",
			filePath: path.join(root, "worker.md"),
			completionGuard: false,
		};
		const interrupt = new AbortController();
		const pending = runSync(root, [agent], "worker", "say done", {
			cwd: root,
			runId: "interrupt-run",
			index: 0,
			acceptance: { level: "none", reason: "interrupt regression" },
			interruptSignal: interrupt.signal,
		});
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		const childPid = Number(fs.readFileSync(pidFile, "utf-8"));
		ignoredChildPids.push(childPid);
		interrupt.abort();
		const result = await pending;
		expect(result.interrupted).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.processSignal).toBe("SIGKILL");
		expect(() => process.kill(childPid, 0)).toThrow();
	}, 20_000);
});
