import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({ remaining: 0, code: "EPERM" }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
			if (failures.remaining > 0 && String(args[0]).endsWith(".lock")) {
				failures.remaining--;
				throw Object.assign(new Error(`${failures.code}: injected`), { code: failures.code });
			}
			return actual.mkdirSync(...args);
		},
	};
});

const { acquireDirectoryLockSync } = await import("../../src/harness/utils/directory-lock.ts");

const roots: string[] = [];
afterEach(() => {
	failures.remaining = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lockPath(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-directory-lock-retry-"));
	roots.push(root);
	return join(root, "settings.json.lock");
}

const isTransient = (error: unknown) =>
	["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

it("retries errors the caller marks retryable on the same schedule", () => {
	const lock = lockPath();
	failures.remaining = 2;
	const release = acquireDirectoryLockSync(lock, { retryDelaysMs: [1, 1, 1], isRetryableError: isTransient });
	expect(existsSync(lock)).toBe(true);
	release();
});

it("still fails on such errors without a predicate, and once the schedule runs out", () => {
	const lock = lockPath();
	failures.remaining = 1;
	expect(() => acquireDirectoryLockSync(lock, { retryDelaysMs: [1, 1] })).toThrow("EPERM");
	failures.remaining = 5;
	expect(() => acquireDirectoryLockSync(lock, { retryDelaysMs: [1, 1], isRetryableError: isTransient })).toThrow(
		"EPERM",
	);
});
