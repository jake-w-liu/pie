import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(policy = "ask", saved?: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "pi-startup-session-trust-"));
	dirs.push(dir);
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	const projectSessions = join(dir, "project-sessions");
	const globalSessions = join(dir, "global-sessions");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ sessionDir: globalSessions, defaultProjectTrust: policy }),
	);
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: projectSessions }));
	if (saved !== undefined) new ProjectTrustStore(agentDir).set(cwd, saved);
	return { dir, cwd, agentDir, projectSessions, globalSessions };
}

async function run(f: ReturnType<typeof setup>, args: string[] = [], envSessionDir = "") {
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			"--offline",
			"--no-extensions",
			"--model",
			"missing-trust-test-model",
			"-p",
			...args,
		],
		{
			cwd: f.cwd,
			env: {
				...process.env,
				HOME: f.dir,
				[ENV_AGENT_DIR]: f.agentDir,
				[ENV_SESSION_DIR]: envSessionDir,
				PI_OFFLINE: "1",
				TEST_TRUST_LOG: join(f.dir, "trust-log"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 25000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal });
		});
	});
	expect(result, stderr).toEqual({ code: 1, signal: null });
	expect(stderr).toContain("missing-trust-test-model");
}

it.each([
	{ label: "explicit denial", flags: ["--no-approve"], policy: "always", saved: true },
	{ label: "saved denial", flags: [], policy: "always", saved: false },
	{ label: "unknown noninteractive trust", flags: [], policy: "ask", saved: undefined },
	{ label: "global never", flags: [], policy: "never", saved: undefined },
])("does not use project sessionDir for $label", async ({ flags, policy, saved }) => {
	const f = setup(policy, saved);
	await run(f, flags);
	expect(existsSync(f.projectSessions)).toBe(false);
	expect(existsSync(f.globalSessions)).toBe(true);
});

it.each([
	{ label: "saved approval", flags: [], policy: "never", saved: true },
	{ label: "explicit approval", flags: ["--approve"], policy: "never", saved: false },
	{ label: "global always", flags: [], policy: "always", saved: undefined },
])("uses project sessionDir for $label", async ({ flags, policy, saved }) => {
	const f = setup(policy, saved);
	await run(f, flags);
	expect(existsSync(f.projectSessions)).toBe(true);
	expect(existsSync(f.globalSessions)).toBe(false);
});

it.each([false, true])("preserves explicit environment/CLI storage precedence (CLI=%s)", async (cli) => {
	const f = setup("ask", false);
	const envDir = join(f.dir, "env-sessions");
	const cliDir = join(f.dir, "cli-sessions");
	await run(f, ["--no-approve", ...(cli ? ["--session-dir", cliDir] : [])], envDir);
	expect(existsSync(cli ? cliDir : envDir)).toBe(true);
	expect(existsSync(cli ? envDir : cliDir)).toBe(false);
	expect(existsSync(f.projectSessions)).toBe(false);
	expect(existsSync(f.globalSessions)).toBe(false);
});

it("resumes a foreign-cwd session without applying either project's storage redirection", async () => {
	const f = setup("ask", false);
	const target = join(f.dir, "other-project");
	mkdirSync(join(target, ".pi"), { recursive: true });
	const targetSessions = join(f.dir, "target-sessions");
	writeFileSync(join(target, ".pi", "settings.json"), JSON.stringify({ sessionDir: targetSessions }));
	new ProjectTrustStore(f.agentDir).set(target, true);
	const path = join(f.dir, "resume.jsonl");
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: "resume", timestamp: new Date().toISOString(), cwd: target })}\n`,
	);
	await run(f, [
		"--session",
		path,
		"--name",
		"resumed",
		"-e",
		fileURLToPath(new URL("./fixtures/startup-trust-extension.ts", import.meta.url)),
	]);
	expect(readFileSync(join(f.dir, "trust-log"), "utf8").trim()).toBe(target);
	expect(readFileSync(path, "utf8")).toContain('"name":"resumed"');
	expect(existsSync(f.projectSessions)).toBe(false);
	expect(existsSync(targetSessions)).toBe(false);
});

it("later extension approval does not retroactively redirect initial storage", async () => {
	const f = setup();
	await run(f, ["-e", fileURLToPath(new URL("./fixtures/startup-trust-extension.ts", import.meta.url))]);
	expect(realpathSync(readFileSync(join(f.dir, "trust-log"), "utf8").trim())).toBe(realpathSync(f.cwd));
	expect(existsSync(f.projectSessions)).toBe(false);
	expect(existsSync(f.globalSessions)).toBe(true);
});

it("continuation ignores a transcript offered through denied project settings", async () => {
	const f = setup("ask", false);
	mkdirSync(f.projectSessions);
	const path = join(f.projectSessions, "offered.jsonl");
	const bytes = `${JSON.stringify({ type: "session", version: 3, id: "offered", timestamp: new Date().toISOString(), cwd: f.cwd })}\n`;
	writeFileSync(path, bytes);
	await run(f, ["--continue", "--name", "must-not-rename-offered"]);
	expect(readFileSync(path, "utf8")).toBe(bytes);
});
