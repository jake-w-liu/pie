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
