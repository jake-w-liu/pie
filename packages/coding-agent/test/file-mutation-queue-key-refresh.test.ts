import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("audit file-mutation-queue key refresh (E3)", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("forwards an operation to the new key when the symlink flips while queued", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mutation-reresolve-"));
		tempDirs.push(dir);
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		const link = join(dir, "link.txt");
		await writeFile(fileA, "a");
		await writeFile(fileB, "b");
		await symlink(fileA, link);

		const events: string[] = [];
		const gate1 = createDeferred();
		const gate3 = createDeferred();

		// op1 holds the A queue with P -> A.
		const op1 = withFileMutationQueue(link, async () => {
			events.push("op1:start");
			await gate1.promise;
			events.push("op1:end");
		});
		await delay(20);
		expect(events).toEqual(["op1:start"]);

		// op2 registers against key A and waits behind op1.
		let op2Started = false;
		const op2 = withFileMutationQueue(link, async () => {
			op2Started = true;
			events.push("op2:run");
		});
		void op2.catch(() => {});
		await delay(20);

		// Flip the symlink, then queue op3 against key B (runs immediately on B).
		await rm(link);
		await symlink(fileB, link);
		const op3 = withFileMutationQueue(link, async () => {
			events.push("op3:start");
			await gate3.promise;
			events.push("op3:end");
		});
		await delay(20);
		expect(events).toContain("op3:start");

		// Release op1. op2 must NOT run in parallel with op3 (it re-queues onto B).
		gate1.resolve();
		await op1;
		await delay(50);
		expect(op2Started).toBe(false);

		gate3.resolve();
		await op3;
		await op2;
		// op3 ran on key B while op1 still held key A; op2 ran only after op3.
		expect(events).toEqual(["op1:start", "op3:start", "op1:end", "op3:end", "op2:run"]);
	});

	it("still serializes plain same-path operations", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mutation-serial-"));
		tempDirs.push(dir);
		const target = join(dir, "file.txt");
		await writeFile(target, "x");

		const order: string[] = [];
		const first = withFileMutationQueue(target, async () => {
			order.push("first:start");
			await delay(30);
			order.push("first:end");
		});
		const second = withFileMutationQueue(target, async () => {
			order.push("second:start");
			order.push("second:end");
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});
});
