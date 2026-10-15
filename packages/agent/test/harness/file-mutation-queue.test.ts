import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { withFileMutationQueue } from "../../src/harness/tools/file-mutation-queue.ts";
import { createTempDir } from "./session-test-utils.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("withFileMutationQueue", () => {
	it("moves a queued operation to the new key when its symlink is repointed while it waits", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		const link = join(dir, "link.txt");
		await writeFile(fileA, "a");
		await writeFile(fileB, "b");
		await symlink(fileA, link);

		// Every key resolution goes through canonicalPath; report the next completed resolution.
		const canonicalPath = env.canonicalPath.bind(env);
		let onNextResolution: (() => void) | undefined;
		vi.spyOn(env, "canonicalPath").mockImplementation(async (...args) => {
			const result = await canonicalPath(...args);
			const notify = onNextResolution;
			onNextResolution = undefined;
			notify?.();
			return result;
		});

		const events: string[] = [];
		const op1Started = deferred();
		const releaseOp1 = deferred();
		const op3Started = deferred();
		const releaseOp3 = deferred();
		const op1 = withFileMutationQueue(env, link, async () => {
			events.push("op1:start");
			op1Started.resolve();
			await releaseOp1.promise;
			events.push("op1:end");
		});
		await op1Started.promise;
		// op2 registers against a.txt and waits behind op1.
		const op2KeyResolved = deferred();
		onNextResolution = op2KeyResolved.resolve;
		const op2 = withFileMutationQueue(env, link, async () => {
			events.push("op2:run");
		});
		await op2KeyResolved.promise;

		// Repoint the link; op3 registers against b.txt and runs immediately.
		await rm(link);
		await symlink(fileB, link);
		const op3 = withFileMutationQueue(env, link, async () => {
			events.push("op3:start");
			op3Started.resolve();
			await releaseOp3.promise;
			events.push("op3:end");
		});
		await op3Started.promise;

		releaseOp1.resolve();
		await op1;
		// Let every continuation of op1's release settle before checking op2.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(events).not.toContain("op2:run");

		releaseOp3.resolve();
		await Promise.all([op2, op3]);
		expect(events).toEqual(["op1:start", "op3:start", "op1:end", "op3:end", "op2:run"]);
	});

	it("still serializes operations on the same path", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const target = join(dir, "file.txt");
		await writeFile(target, "x");
		const order: string[] = [];
		const releaseFirst = deferred();
		const firstStarted = deferred();

		const first = withFileMutationQueue(env, target, async () => {
			order.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			order.push("first:end");
		});
		const second = withFileMutationQueue(env, target, async () => {
			order.push("second:run");
		});
		await firstStarted.promise;
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(order).toEqual(["first:start", "first:end", "second:run"]);
	});
});
