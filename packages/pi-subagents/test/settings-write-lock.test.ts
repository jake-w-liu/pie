import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mergeBuiltinAgentOverride, removeBuiltinAgentOverrideFields } from "../src/agents/agents.ts";

// The state lock waits through the file-system retry ladder (about 8s) before giving
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

		expect(() => mergeBuiltinAgentOverride(process.cwd(), "worker", "user", { model: "c/d" })).toThrow(/Timed out acquiring/);
		expect(() => removeBuiltinAgentOverrideFields(process.cwd(), "worker", "user", ["disabled"])).toThrow(/Timed out acquiring/);
		expect(fs.readFileSync(settingsPath, "utf-8")).toBe(original);

		fs.rmdirSync(`${settingsPath}.lock`);
		expect(removeBuiltinAgentOverrideFields(process.cwd(), "worker", "user", ["disabled"]).removed).toBe(true);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8"))).toEqual({ subagents: { agentOverrides: { worker: { model: "a/b" } } } });
	});
});
