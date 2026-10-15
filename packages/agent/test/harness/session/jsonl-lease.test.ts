import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import {
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type JsonlSessionRepoFileSystem,
	type JsonlSessionRepoOptions,
	Session,
} from "../../../src/harness/session/index.ts";
import { acquireJsonlWriterLease } from "../../../src/harness/session/jsonl/lease.ts";
import { loadJsonlSessionStorage } from "../../../src/harness/session/jsonl/repo.ts";
import { FileError } from "../../../src/harness/types.ts";

const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-jsonl-lease-"));
	roots.push(root);
	const fs = new NodeExecutionEnv({ cwd: root });
	const options = { fs, sessionsRoot: root };
	const repo = new JsonlSessionRepo(options);
	return { root, fs, options, repo };
}

async function readEntryIds(options: JsonlSessionRepoOptions, metadata: JsonlSessionMetadata): Promise<string[]> {
	const storage = await loadJsonlSessionStorage(options, metadata);
	return (await storage.findEntries({ order: "oldestFirst" })).map((entry) => entry.id);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/** Pause the first call of `method` until released, as if the process were descheduled right before it. */
function pauseFirstCall(
	fs: NodeExecutionEnv,
	method: "renameFile" | "writeFile",
): { fs: JsonlSessionRepoFileSystem; reached: Promise<void>; release: () => void } {
	const reached = deferred();
	const released = deferred();
	let paused = false;
	const pausedFs = new Proxy(fs, {
		get(target, property, receiver) {
			if (property === method) {
				return async (...args: unknown[]) => {
					if (!paused) {
						paused = true;
						reached.resolve();
						await released.promise;
					}
					return Reflect.apply(target[method], target, args);
				};
			}
			const value: unknown = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as JsonlSessionRepoFileSystem;
	return { fs: pausedFs, reached: reached.promise, release: released.resolve };
}

function isUsable(lease: { assertUsable(): void }): boolean {
	try {
		lease.assertUsable();
		return true;
	} catch {
		return false;
	}
}

describe("JSONL writer lease", () => {
	it("steals an expired foreign-host lease and removes it on close", async () => {
		const { root, repo } = fixture();
		const created = await repo.create({ id: "stale", cwd: root });
		const metadata = await created.getMetadata();
		await created.close();

		const lockPath = `${metadata.path}.lock`;
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner.json"),
			`${JSON.stringify({
				ownerId: "stale-owner",
				pid: 999_999_999,
				hostname: `${hostname()}-foreign`,
				acquiredAt: 1,
				renewedAt: 1,
			})}\n`,
		);

		const session = await repo.open(metadata);
		await session.appendEntry({ type: "custom", id: "after-stale", customType: "test" }, "main");
		expect(existsSync(lockPath)).toBe(true);
		expect(readdirSync(join(lockPath, "..")).some((name) => name.includes(".lock.stale-"))).toBe(false);
		await session.close();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("degrades cleanly when non-recursive directory creation is unsupported", async () => {
		const { root, fs, repo } = fixture();
		const created = await repo.create({ id: "degraded", cwd: root });
		const metadata = await created.getMetadata();
		await created.close();

		const degraded = new Proxy(fs, {
			get(target, property, receiver) {
				if (property === "createDir") {
					return async (_path: string, options?: { recursive?: boolean }) =>
						options?.recursive === false
							? { ok: false as const, error: new FileError("not_supported", "exclusive create unsupported") }
							: target.createDir(_path, options);
				}
				const value: unknown = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as JsonlSessionRepoFileSystem;
		const session = await new JsonlSessionRepo({ fs: degraded, sessionsRoot: root }).open(metadata);
		await session.appendEntry({ type: "custom", id: "degraded-entry", customType: "test" }, "main");
		await session.close();
		expect(existsSync(`${metadata.path}.lock`)).toBe(false);

		const reopened = await repo.open(metadata);
		expect((await reopened.findEntries()).map((entry) => entry.id)).toEqual(["degraded-entry"]);
		await reopened.close();
	});

	it("recovers a lease whose owner record was never published or is unreadable", async () => {
		const { root, fs, repo } = fixture();
		const created = await repo.create({ id: "abandoned", cwd: root });
		const metadata = await created.getMetadata();
		await created.close();
		const lockPath = `${metadata.path}.lock`;
		const ownerPath = join(lockPath, "owner.json");
		const stale = new Date(Date.now() - 60_000);

		// A crash between claiming the lock directory and publishing owner.json.
		mkdirSync(lockPath);
		utimesSync(lockPath, stale, stale);
		const afterMissingOwner = await repo.open(metadata);
		await afterMissingOwner.appendEntry({ type: "custom", id: "after-missing-owner", customType: "test" }, "main");
		await afterMissingOwner.close();
		expect(existsSync(lockPath)).toBe(false);

		// A crash while writing owner.json leaves an unreadable record.
		mkdirSync(lockPath);
		writeFileSync(ownerPath, '{"ownerId":"torn","pid":');
		utimesSync(lockPath, stale, stale);
		const afterTornOwner = await repo.open(metadata);
		await afterTornOwner.appendEntry({ type: "custom", id: "after-torn-owner", customType: "test" }, "main");
		await afterTornOwner.close();
		expect(existsSync(lockPath)).toBe(false);

		expect(await readEntryIds({ fs, sessionsRoot: root }, metadata)).toEqual([
			"after-missing-owner",
			"after-torn-owner",
		]);
	});

	it("does not steal a fresh lease that replaced the stale lease it judged", async () => {
		const { root, fs } = fixture();
		const sessionPath = join(root, "session.jsonl");
		writeFileSync(sessionPath, "");
		const lockPath = `${sessionPath}.lock`;
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner.json"),
			`${JSON.stringify({
				ownerId: "stale-owner",
				pid: 999_999_999,
				hostname: `${hostname()}-foreign`,
				acquiredAt: 1,
				renewedAt: 1,
			})}\n`,
		);

		// B judges the lease stale, then stalls just before moving it away.
		const stalled = pauseFirstCall(fs, "renameFile");
		const leaseB = acquireJsonlWriterLease(stalled.fs, sessionPath);
		void leaseB.catch(() => {});
		await stalled.reached;
		// A steals the same stale lease and publishes a fresh one.
		const leaseA = await acquireJsonlWriterLease(fs, sessionPath);
		const ownerA = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).ownerId;
		stalled.release();

		await expect(leaseB).rejects.toMatchObject({ code: "already_exists" });
		expect(isUsable(leaseA)).toBe(true);
		expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).ownerId).toBe(ownerA);
		expect(readdirSync(root).filter((name) => name.includes(".lock.stale-"))).toEqual([]);
		await leaseA.close();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not steal a fresh lease whose owner record is not yet published", async () => {
		const { root, fs } = fixture();
		const sessionPath = join(root, "session.jsonl");
		writeFileSync(sessionPath, "");
		const lockPath = `${sessionPath}.lock`;
		// An abandoned lock directory that never got an owner record.
		mkdirSync(lockPath);
		const stale = new Date(Date.now() - 60_000);
		utimesSync(lockPath, stale, stale);

		const stalledB = pauseFirstCall(fs, "renameFile");
		const leaseB = acquireJsonlWriterLease(stalledB.fs, sessionPath);
		void leaseB.catch(() => {});
		await stalledB.reached;
		// A steals the abandoned lock and claims a fresh directory, but stalls before publishing its owner.
		const stalledA = pauseFirstCall(fs, "writeFile");
		const leaseA = acquireJsonlWriterLease(stalledA.fs, sessionPath);
		await stalledA.reached;
		stalledB.release();

		await expect(leaseB).rejects.toMatchObject({ code: "already_exists" });
		stalledA.release();
		const holder = await leaseA;
		expect(isUsable(holder)).toBe(true);
		expect(existsSync(join(lockPath, "owner.json"))).toBe(true);
		expect(readdirSync(root).filter((name) => name.includes(".lock.stale-"))).toEqual([]);
		await holder.close();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("keeps a fresh unreadable lease locked while its holder may still publish it", async () => {
		const { root, repo } = fixture();
		const created = await repo.create({ id: "in-progress", cwd: root });
		const metadata = await created.getMetadata();
		await created.close();

		mkdirSync(`${metadata.path}.lock`);
		await expect(repo.open(metadata)).rejects.toThrow(/acquisition is in progress/);
	});

	it("serves readers while a writer holds the lease", async () => {
		const { root, options, repo } = fixture();
		const created = await repo.create({ id: "readers", cwd: root });
		await created.appendEntry({ type: "custom", id: "first", customType: "test" }, "main");
		const metadata = await created.getMetadata();

		const firstReader = await loadJsonlSessionStorage(options, metadata);
		const secondReader = await loadJsonlSessionStorage(options, metadata);
		expect(await firstReader.findEntries({ order: "oldestFirst" })).toHaveLength(1);
		expect(await secondReader.findEntries({ order: "oldestFirst" })).toHaveLength(1);

		await created.appendEntry({ type: "custom", id: "second", customType: "test" }, "main");
		// A reader observes the writer's acknowledged appends, not a snapshot taken at open time.
		expect(await readEntryIds(options, metadata)).toEqual(["first", "second"]);

		await created.close();
		// Readers never claim the lease, so releasing the writer removes the lock entirely.
		expect(existsSync(`${metadata.path}.lock`)).toBe(false);
	});

	it("refuses writes through a read-only handle", async () => {
		const { root, options, repo } = fixture();
		const created = await repo.create({ id: "read-only", cwd: root });
		await created.appendEntry({ type: "custom", id: "kept", customType: "test" }, "main");
		const metadata = await created.getMetadata();
		await created.close();
		const before = readFileSync(metadata.path, "utf8");

		const reader = new Session(await loadJsonlSessionStorage(options, metadata));
		await expect(reader.appendCustomEntry("rejected")).rejects.toThrow(/read-only/);
		expect(readFileSync(metadata.path, "utf8")).toBe(before);
		expect(existsSync(`${metadata.path}.lock`)).toBe(false);
		await reader.close();
	});

	it("leaves a torn tail and an unterminated tail unmodified for readers", async () => {
		const { root, options, repo } = fixture();
		const created = await repo.create({ id: "torn-reader", cwd: root });
		await created.appendEntry({ type: "custom", id: "complete", customType: "test" }, "main");
		const metadata = await created.getMetadata();
		await created.close();
		const complete = readFileSync(metadata.path, "utf8");

		appendFileSync(metadata.path, '{"kind":"entry"');
		const torn = readFileSync(metadata.path, "utf8");
		expect(await readEntryIds(options, metadata)).toEqual(["complete"]);
		expect(readFileSync(metadata.path, "utf8")).toBe(torn);

		writeFileSync(metadata.path, complete.slice(0, -1));
		const unterminated = readFileSync(metadata.path, "utf8");
		expect(await readEntryIds(options, metadata)).toEqual(["complete"]);
		expect(readFileSync(metadata.path, "utf8")).toBe(unterminated);
	});
});
