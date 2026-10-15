import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mergeBuiltinAgentOverride, removeBuiltinAgentOverrideFields } from "../src/agents/agents.ts";
import { applySubagentProfile } from "../src/profiles/profiles.ts";
import { writeUserWatchdogEnabled } from "../src/watchdog/settings.ts";

// The settings lock waits through the file-system retry ladder (about 8s) before giving
// up. A zero budget, read when file-system-retry.ts loads, surfaces contention at once.
const originalRetryBudget = vi.hoisted(() => {
	const previous = process.env.PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS;
	process.env.PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS = "0";
	return previous;
});

const roots: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	process.env = { ...originalEnv };
});

afterAll(() => {
	if (originalRetryBudget === undefined) delete process.env.PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS;
	else process.env.PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS = originalRetryBudget;
});

function userSettingsPath(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-lock-"));
	roots.push(root);
	const agentDir = path.join(root, "home", ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	process.env.HOME = path.join(root, "home");
	// PIE_CODING_AGENT_DIR wins over PI_CODING_AGENT_DIR and would point at a real agent dir.
	delete process.env.PIE_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return path.join(agentDir, "settings.json");
}

describe("C7: shared settings.json override writes", () => {
	it("replaces settings.json atomically instead of truncating it in place", () => {
		const settingsPath = userSettingsPath();
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));
		const inodeBefore = fs.statSync(settingsPath).ino;

		mergeBuiltinAgentOverride(process.cwd(), "worker", "user", { disabled: true });

		expect(fs.statSync(settingsPath).ino).not.toBe(inodeBefore);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark", subagents: { agentOverrides: { worker: { disabled: true } } } });
		expect(fs.readdirSync(path.dirname(settingsPath))).toEqual(["settings.json"]);
	});

	it("waits for the settings lock other writers hold", () => {
		const settingsPath = userSettingsPath();
		const original = JSON.stringify({ subagents: { agentOverrides: { worker: { disabled: true, model: "a/b" } } } }, null, 2);
		fs.writeFileSync(settingsPath, original);
		// Same lock directory the coding agent's settings writer (proper-lockfile) uses.
		fs.mkdirSync(`${settingsPath}.lock`);

		expect(() => mergeBuiltinAgentOverride(process.cwd(), "worker", "user", { model: "c/d" })).toThrow(/Lock is held by another writer/);
		expect(() => removeBuiltinAgentOverrideFields(process.cwd(), "worker", "user", ["disabled"])).toThrow(/Lock is held by another writer/);
		expect(fs.readFileSync(settingsPath, "utf-8")).toBe(original);

		fs.rmdirSync(`${settingsPath}.lock`);
		expect(removeBuiltinAgentOverrideFields(process.cwd(), "worker", "user", ["disabled"]).removed).toBe(true);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({ subagents: { agentOverrides: { worker: { model: "a/b" } } } });
	});
});

// Symlinks, POSIX modes, and FIFOs are not portable to Windows.
describe.skipIf(process.platform === "win32")("settings.json writes shared with the coding agent", () => {
	const writers: Array<[string, () => void]> = [
		[
			"an agent override",
			() => {
				mergeBuiltinAgentOverride(process.cwd(), "worker", "user", { disabled: true });
			},
		],
		[
			"the watchdog toggle",
			() => {
				writeUserWatchdogEnabled(true);
			},
		],
		[
			"a profile switch",
			() => {
				const profilesDir = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "profiles", "pi-subagents");
				fs.mkdirSync(profilesDir, { recursive: true });
				fs.writeFileSync(path.join(profilesDir, "quality.json"), JSON.stringify({ subagents: { agentOverrides: { worker: { model: "a/b" } } } }));
				applySubagentProfile("quality");
			},
		],
	];

	it.each(writers)("%s writes through a symlinked settings.json and keeps its mode", (_writer, write) => {
		const settingsPath = userSettingsPath();
		const dotfiles = path.join(path.dirname(settingsPath), "..", "..", "dotfiles");
		fs.mkdirSync(dotfiles);
		const target = path.join(dotfiles, "settings.json");
		fs.writeFileSync(target, JSON.stringify({ theme: "dark" }, null, 2));
		fs.chmodSync(target, 0o600);
		fs.symlinkSync(target, settingsPath);

		write();

		expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
		const written = JSON.parse(fs.readFileSync(target, "utf-8")) as Record<string, unknown>;
		expect(written.theme).toBe("dark");
		expect(written.subagents).toBeDefined();
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(dotfiles)).toEqual(["settings.json"]);
	});

	it("keeps a mode the umask would narrow", () => {
		const settingsPath = userSettingsPath();
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));
		// Group-writable: a temp file created with the default umask (022) comes out 0644.
		fs.chmodSync(settingsPath, 0o664);

		mergeBuiltinAgentOverride(process.cwd(), "worker", "user", { disabled: true });

		expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o664);
	});

	it("leaves a lock the coding agent reclaims when a writer dies holding it", async () => {
		const settingsPath = userSettingsPath();
		// settings.json as a FIFO: the writer's read inside its critical section blocks until it
		// is killed, so it dies holding the lock.
		execFileSync("mkfifo", [settingsPath]);
		const agentsUrl = new URL("../src/agents/agents.ts", import.meta.url).href;
		const child: ChildProcess = spawn(
			process.execPath,
			["--input-type=module", "-e", `const { mergeBuiltinAgentOverride } = await import(${JSON.stringify(agentsUrl)});\nmergeBuiltinAgentOverride(process.cwd(), "worker", "user", { disabled: true });`],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = once(child, "exit");
		let fifoWriter: number | undefined;
		try {
			while (fifoWriter === undefined) {
				try {
					// A non-blocking open of the write end succeeds only once the writer holds the FIFO
					// open for reading, which it does after taking the lock.
					fifoWriter = fs.openSync(settingsPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
					if (child.exitCode !== null) throw new Error(`settings writer exited early: ${stderr}`);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
		} finally {
			child.kill("SIGKILL");
			await exited;
			if (fifoWriter !== undefined) fs.closeSync(fifoWriter);
		}

		const lockPath = `${settingsPath}.lock`;
		expect(fs.existsSync(lockPath)).toBe(true);
		// Age the dead writer's lock past proper-lockfile's 10 s stale threshold instead of waiting.
		const stale = new Date(Date.now() - 60_000);
		fs.utimesSync(lockPath, stale, stale);
		// The coding agent's FileSettingsStorage takes the settings lock with exactly this call.
		const release = lockfile.lockSync(settingsPath, { realpath: false });
		release();

		fs.rmSync(settingsPath);
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));
		mergeBuiltinAgentOverride(process.cwd(), "worker", "user", { disabled: true });
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark", subagents: { agentOverrides: { worker: { disabled: true } } } });
	}, 60_000);
});
