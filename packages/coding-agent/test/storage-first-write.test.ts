import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGKILL");
			await exited;
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-storage-first-write-"));
	dirs.push(dir);
	return dir;
}

async function delayedWriter(kind: string, path: string, dir: string, scope?: string) {
	const ready = join(dir, "ready");
	const resume = join(dir, "resume");
	const child = spawn(
		process.execPath,
		[
			fileURLToPath(new URL("./fixtures/storage-first-writer.ts", import.meta.url)),
			kind,
			path,
			ready,
			resume,
			...(scope ? [scope] : []),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	await expect
		.poll(() => (existsSync(ready) ? "ready" : child.exitCode === null ? "waiting" : stderr), { timeout: 10000 })
		.toBe("ready");
	return async () => {
		writeFileSync(resume, "resume");
		expect(await exited, stderr).toBe(0);
	};
}

it.each(["auth-sync", "auth-async", "auth-sync-open", "auth-async-open"])(
	"%s initial creation cannot truncate a competing credential commit",
	async (kind) => {
		const dir = directory();
		const path = join(dir, "auth.json");
		const finish = await delayedWriter(kind, path, dir);
		const backend = new FileAuthStorageBackend(path);
		let observedContention!: () => void;
		const contended = new Promise<void>((resolve) => {
			observedContention = resolve;
		});
		const lock = lockfile.lock;
		vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			try {
				return await lock(file, options);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ELOCKED") observedContention();
				throw error;
			}
		});
		const competing = backend.withLockAsync(async (current) => ({
			result: undefined,
			next: JSON.stringify({ ...JSON.parse(current || "{}"), first: { type: "api_key", key: "committed" } }),
		}));
		// Release the delayed writer only after an actual competing lock attempt:
		// the broken owner lets that writer commit; the fixed owner holds it out.
		await Promise.race([competing, contended]);
		await finish();
		await competing;
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			first: { type: "api_key", key: "committed" },
			delayed: { type: "api_key", key: "second" },
		});
		expect(existsSync(`${path}.lock`)).toBe(false);
	},
);

it.each(["global", "project"] as const)("merges concurrent first %s settings writes under the lock", async (scope) => {
	const dir = directory();
	const configDir = join(dir, "config");
	const finish = await delayedWriter("settings", configDir, dir, scope);
	const first = SettingsManager.create(configDir, configDir);
	if (scope === "global") first.setDefaultModel("committed-model");
	else first.setProjectPromptTemplatePaths(["committed-prompt"]);
	await first.flush();
	expect(first.drainErrors()).toEqual([]);
	await finish();
	const path = join(configDir, ...(scope === "project" ? [".pi"] : []), "settings.json");
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(
		scope === "global"
			? { defaultModel: "committed-model", theme: "delayed-theme" }
			: { prompts: ["committed-prompt"], skills: ["delayed-skill"] },
	);
	expect(existsSync(`${path}.lock`)).toBe(false);
});

it("reading absent settings does not create configuration directories", () => {
	const dir = directory();
	const configDir = join(dir, "absent");
	const manager = SettingsManager.create(configDir, configDir);
	expect(manager.drainErrors()).toEqual([]);
	expect(existsSync(configDir)).toBe(false);
});

it("releases the settings lock after a failed mutation and preserves committed bytes", () => {
	const dir = directory();
	const storage = new FileSettingsStorage(dir, dir);
	storage.withLock("global", () => "{}");
	expect(() =>
		storage.withLock("global", () => {
			throw new Error("mutation failed");
		}),
	).toThrow("mutation failed");
	expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{}");
	expect(existsSync(join(dir, "settings.json.lock"))).toBe(false);
	storage.withLock("global", () => '{"theme":"recovered"}');
	expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "recovered" });
});
