import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireDirectoryLockSync,
	DIRECTORY_LOCK_STALE_MS,
	DirectoryLockBusyError,
} from "../../src/harness/utils/directory-lock.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-directory-lock-"));
	roots.push(root);
	return root;
}

/** Make a lock directory look abandoned by moving its mtime past the stale threshold. */
function age(path: string): void {
	const past = new Date(Date.now() - DIRECTORY_LOCK_STALE_MS - 5_000);
	utimesSync(path, past, past);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("acquireDirectoryLockSync", () => {
	it("acquires, releases, and tolerates a repeated release", () => {
		const lock = join(tempRoot(), "settings.json.lock");
		const release = acquireDirectoryLockSync(lock, { retryDelaysMs: [] });
		expect(existsSync(lock)).toBe(true);
		release();
		release();
		expect(existsSync(lock)).toBe(false);
	});

	it("waits out its schedule and reports a lock held by a live writer", () => {
		const lock = join(tempRoot(), "settings.json.lock");
		mkdirSync(lock);
		expect(() => acquireDirectoryLockSync(lock, { retryDelaysMs: [1, 1] })).toThrow(DirectoryLockBusyError);
		expect(existsSync(lock)).toBe(true);
	});

	it("reclaims an abandoned lock, including one that holds an owner record", () => {
		const root = tempRoot();
		const lock = join(root, "settings.json.lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "owner.json"), "{}");
		age(lock);
		const release = acquireDirectoryLockSync(lock, { retryDelaysMs: [] });
		expect(existsSync(join(lock, "owner.json"))).toBe(false);
		release();
		expect(existsSync(`${lock}.reclaim`)).toBe(false);
	});

	it("does not remove an abandoned lock while another writer is reclaiming it", () => {
		const lock = join(tempRoot(), "settings.json.lock");
		mkdirSync(lock);
		age(lock);
		// Another writer holds the reclaim mutex: it may be about to take this lock itself.
		mkdirSync(`${lock}.reclaim`);
		expect(() => acquireDirectoryLockSync(lock, { retryDelaysMs: [1, 1] })).toThrow(DirectoryLockBusyError);
		expect(existsSync(lock)).toBe(true);

		rmSync(`${lock}.reclaim`, { recursive: true });
		const release = acquireDirectoryLockSync(lock, { retryDelaysMs: [] });
		release();
	});

	it("clears a reclaim mutex left by a writer that crashed while reclaiming", () => {
		const lock = join(tempRoot(), "settings.json.lock");
		mkdirSync(lock);
		age(lock);
		mkdirSync(`${lock}.reclaim`);
		age(`${lock}.reclaim`);
		const release = acquireDirectoryLockSync(lock, { retryDelaysMs: [1, 1, 1] });
		expect(existsSync(`${lock}.reclaim`)).toBe(false);
		release();
	});

	it("interoperates with proper-lockfile on the same path", () => {
		const root = tempRoot();
		const file = join(root, "settings.json");
		writeFileSync(file, "{}");
		const lock = `${file}.lock`;

		// proper-lockfile reclaims a lock this helper abandoned...
		acquireDirectoryLockSync(lock, { retryDelaysMs: [] });
		age(lock);
		lockfile.lockSync(file, { realpath: false })();

		// ...and this helper waits for, then reclaims, one proper-lockfile abandoned.
		lockfile.lockSync(file, { realpath: false });
		expect(() => acquireDirectoryLockSync(lock, { retryDelaysMs: [1] })).toThrow(DirectoryLockBusyError);
		age(lock);
		acquireDirectoryLockSync(lock, { retryDelaysMs: [] })();
	});

	it("never lets two processes hold the lock at once after it was abandoned", async () => {
		const root = tempRoot();
		const lock = join(root, "settings.json.lock");
		const go = join(root, "go");
		const journal = join(root, "journal");
		writeFileSync(journal, "");
		mkdirSync(lock);
		age(lock);
		const moduleUrl = new URL("../../src/harness/utils/directory-lock.ts", import.meta.url).href;
		const worker = join(root, "worker.ts");
		writeFileSync(
			worker,
			`import { appendFileSync, existsSync } from "node:fs";
const { acquireDirectoryLockSync } = await import(${JSON.stringify(moduleUrl)});
const [lock, go, journal, id] = process.argv.slice(2);
while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 2));
const release = acquireDirectoryLockSync(lock, { retryDelaysMs: Array.from({ length: 2000 }, () => 5) });
appendFileSync(journal, "enter " + id + "\\n");
const until = Date.now() + 20;
while (Date.now() < until) {}
appendFileSync(journal, "exit " + id + "\\n");
release();
`,
		);
		const children = Array.from({ length: 8 }, (_, index) =>
			spawn(process.execPath, [worker, lock, go, journal, String(index)], { stdio: "ignore" }),
		);
		const exits = children.map((child) => new Promise<number | null>((resolve) => child.once("close", resolve)));
		await new Promise((resolve) => setTimeout(resolve, 500));
		writeFileSync(go, "");
		expect(await Promise.all(exits)).toEqual(Array.from({ length: 8 }, () => 0));

		// Every enter must be followed by the same writer's exit before anyone else enters.
		const events = readFileSync(journal, "utf8").trim().split("\n");
		expect(events).toHaveLength(16);
		for (let index = 0; index < events.length; index += 2) {
			expect(events[index]!.replace("enter", "exit")).toBe(events[index + 1]);
		}
	}, 60_000);
});
