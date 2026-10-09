import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, win32 } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { type JsonlSessionMetadata, JsonlSessionRepo } from "../../../src/harness/session/index.ts";
import { metadataFromHeader, parseHeader } from "../../../src/harness/session/jsonl/codec.ts";
import { FileError } from "../../../src/harness/types.ts";

const directories: string[] = [];

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture() {
	const directory = await fs.mkdtemp(join(tmpdir(), "pi-jsonl-identity-"));
	directories.push(directory);
	const root = join(directory, "sessions");
	const aliasRoot = join(directory, "alias");
	await fs.mkdir(root);
	await fs.symlink(root, aliasRoot, "dir");
	const env = new NodeExecutionEnv({ cwd: directory });
	return { directory, root, aliasRoot, env };
}

function aliasMetadata(metadata: JsonlSessionMetadata, root: string, aliasRoot: string): JsonlSessionMetadata {
	return { ...metadata, path: join(aliasRoot, relative(root, metadata.path)) };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("JSONL canonical file ownership", () => {
	for (const aliasedCreate of [false, true]) {
		it.each([false, true])(
			`shares the writer through aliases (aliased create=${aliasedCreate}, concurrent=%s)`,
			async (concurrent) => {
				const { root, aliasRoot, directory, env } = await fixture();
				const canonicalRoot = await fs.realpath(root);
				const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: aliasedCreate ? aliasRoot : root });
				const first = await repo.create({ id: "alias-writer", cwd: directory });
				const metadata = await first.getMetadata();
				const addressed = aliasMetadata(metadata, canonicalRoot, aliasRoot);
				const second = await repo.open(addressed);
				const append = (session: typeof first, id: string) =>
					session.appendEntry({ type: "custom", id, customType: "note" }, "main");
				const receipts = concurrent
					? await Promise.all([append(first, "first"), append(second, "second")])
					: [await append(first, "first"), await append(second, "second")];
				expect(receipts.map((receipt) => receipt.seq)).toEqual([1, 2]);
				expect(receipts.map((receipt) => receipt.parentId)).toEqual([null, "first"]);
				expect(metadata.path).toBe(await fs.realpath(addressed.path));
				expect(metadata.cwd).toBe(directory);
				expect((await repo.list({ cwd: directory }))[0].path).toBe(metadata.path);
				const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(addressed);
				expect((await replay.getLog()).map((item) => item.seq)).toEqual([1, 2]);
			},
		);
	}

	it("repairs a failed aliased append without replacing the symlink or losing acknowledged writes", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const first = await repo.create({ id: "alias-recovery", cwd: directory });
		const metadata = await first.getMetadata();
		const alias = join(directory, "file-alias.jsonl");
		await fs.symlink(metadata.path, alias);
		const second = await repo.open({ ...metadata, path: alias });
		await first.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main");
		const appendFile = env.appendFile.bind(env);
		vi.spyOn(env, "appendFile").mockImplementationOnce(async (path, data) => {
			await appendFile(path, String(data).slice(0, 12));
			return { ok: false, error: new FileError("unknown", "partial write", path) };
		});
		await expect(
			second.appendEntry({ type: "custom", id: "failed", customType: "note" }, "main"),
		).rejects.toMatchObject({ code: "storage" });
		const accepted = await first.appendEntry({ type: "custom", id: "next", customType: "note" }, "main");
		expect(accepted).toMatchObject({ seq: 2, parentId: "kept" });
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
		const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open({ ...metadata, path: alias });
		expect((await replay.getLog()).map((item) => item.seq)).toEqual([1, 2]);
	});

	it("forks through aliases without rereading the source and shares the destination writer", async () => {
		const { directory, root, aliasRoot, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: aliasRoot });
		const source = await repo.create({ id: "source", cwd: directory });
		const metadata = await source.getMetadata();
		await source.appendCustomEntry("kept");
		const canonicalRoot = await fs.realpath(root);
		const read = vi.spyOn(env, "readTextFile");
		const forks = await Promise.all(
			["one", "two"].map((id) =>
				repo.fork(aliasMetadata(metadata, canonicalRoot, aliasRoot), { id, cwd: directory, scope: "tree" }),
			),
		);
		expect(read.mock.calls.some(([path]) => path === metadata.path)).toBe(false);
		for (const fork of forks) {
			const forkMetadata = await fork.getMetadata();
			const alias = aliasMetadata(forkMetadata, canonicalRoot, aliasRoot);
			const second = await repo.open(alias);
			const before = (await fork.getLog()).length;
			const firstReceipt = await fork.appendEntry({ type: "custom", id: "first", customType: "note" }, "main");
			const secondReceipt = await second.appendEntry({ type: "custom", id: "second", customType: "note" }, "main");
			expect(firstReceipt.seq).toBe(before + 1);
			expect(secondReceipt).toMatchObject({ seq: before + 2, parentId: firstReceipt.id });
			const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(alias);
			expect((await replay.getLog()).map((item) => item.seq)).toEqual(
				Array.from({ length: before + 2 }, (_, index) => index + 1),
			);
		}
	});

	it.each(
		(["create", "open", "fork", "delete", "list"] as const).flatMap((operation) =>
			(["permission_denied", "not_found"] as const).map((errorCode) => ({ operation, errorCode })),
		),
	)("propagates $errorCode canonical resolution failures during $operation", async ({ operation, errorCode }) => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repo.create({ id: "source", cwd: directory });
		const metadata = await source.getMetadata();
		const failure = new FileError(errorCode, "canonical resolution denied", metadata.path);
		const canonical = vi.spyOn(env, "canonicalPath").mockResolvedValueOnce({ ok: false, error: failure });
		const write = vi.spyOn(env, "writeFile");
		const remove = vi.spyOn(env, "remove");
		const pending =
			operation === "create"
				? repo.create({ id: "next", cwd: directory })
				: operation === "open"
					? repo.open(metadata)
					: operation === "fork"
						? repo.fork(metadata, { id: "next", cwd: directory, scope: "tree" })
						: operation === "delete"
							? repo.delete(metadata)
							: repo.list();
		await expect(pending).rejects.toMatchObject({
			code: errorCode === "not_found" ? "not_found" : "storage",
			cause: failure,
		});
		expect(write).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		canonical.mockRestore();
		expect((await source.appendEntry({ type: "custom", id: "usable", customType: "note" }, "main")).seq).toBe(1);
		await expect(repo.create({ id: "next", cwd: directory })).resolves.toBeDefined();
	});
});

describe("JSONL physical creation ownership", () => {
	for (const topology of ["cwd-encoding", "directory-alias"] as const) {
		for (const distinctTimes of [false, true]) {
			it.each([
				["create", "create"],
				["create", "fork"],
				["fork", "fork"],
			] as const)(
				`${topology}, distinct timestamps=${distinctTimes}: one owner for concurrent %s/%s`,
				async (firstKind, secondKind) => {
					const { directory, root, env } = await fixture();
					const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
					const cwdA = join(directory, "a", "b");
					const cwdB = topology === "cwd-encoding" ? join(directory, "a-b") : join(directory, "other");
					const seedA = await repo.create({ id: "seed-a", cwd: cwdA });
					const seedB = await repo.create({ id: "seed-b", cwd: cwdB });
					const metadataA = await seedA.getMetadata();
					const metadataB = await seedB.getMetadata();
					const dirA = dirname(metadataA.path);
					const dirB = dirname(metadataB.path);
					await repo.delete(metadataA);
					await repo.delete(metadataB);
					if (topology === "directory-alias") {
						await fs.rmdir(dirB);
						await fs.symlink(dirA, dirB, "dir");
					} else expect(dirA).toBe(dirB);
					const source = await repo.create({ id: "source", cwd: join(directory, "source") });
					const sourceMetadata = await source.getMetadata();
					let now = 1_700_000_000_000;
					vi.spyOn(Date, "now").mockImplementation(() => (distinctTimes ? now++ : now));
					const admitted = gate();
					const release = gate();
					const listDir = env.listDir.bind(env);
					let held = false;
					vi.spyOn(env, "listDir").mockImplementation(async (path, signal) => {
						const result = await listDir(path, signal);
						if (!held && (await fs.realpath(path)) === dirA) {
							held = true;
							admitted.resolve();
							await release.promise;
						}
						return result;
					});
					const run = (kind: "create" | "fork", cwd: string) =>
						kind === "create"
							? repo.create({ id: "destination", cwd })
							: repo.fork(sourceMetadata, { id: "destination", cwd });
					const first = run(firstKind, cwdA);
					await admitted.promise;
					const second = run(secondKind, cwdB).then(
						(value) => ({ status: "fulfilled", value }) as const,
						(reason: unknown) => ({ status: "rejected", reason }) as const,
					);
					let secondResult: Awaited<typeof second>;
					try {
						secondResult = await second;
					} finally {
						release.resolve();
					}
					const winner = await first;
					expect(secondResult.status).toBe("rejected");
					if (secondResult.status !== "rejected") throw new Error("Competing creator was published");
					expect(secondResult.reason).toMatchObject({ code: "already_exists" });
					expect((await fs.readdir(dirA)).filter((name) => name.endsWith("_destination.jsonl"))).toHaveLength(1);
					const metadata = await winner.getMetadata();
					expect(metadata.cwd).toBe(cwdA);
					const before = (await winner.getLog()).length;
					const firstReceipt = await winner.appendEntry(
						{ type: "custom", id: "first", customType: "note" },
						"main",
					);
					const secondReceipt = await (await repo.open(metadata)).appendEntry(
						{ type: "custom", id: "second", customType: "note" },
						"main",
					);
					expect([firstReceipt.seq, secondReceipt.seq]).toEqual([before + 1, before + 2]);
					const verified = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
					expect(await verified.getLog()).toEqual(await winner.getLog());
					await expect(run(secondKind, cwdB)).rejects.toMatchObject({ code: "already_exists" });
					const active: unknown = Reflect.get(repo, "activeCreateDestinations");
					expect(active instanceof Set && active.size).toBe(0);
				},
			);
		}
	}

	it("does not mistake an old alias registration for a canonical owner in a separate directory", async () => {
		const { directory, root, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repo.create({ id: "destination", cwd: join(directory, "source") });
		const sourceMetadata = await source.getMetadata();
		const destinationCwd = join(directory, "separate");
		const seed = await repo.create({ id: "seed", cwd: destinationCwd });
		const seedMetadata = await seed.getMetadata();
		await repo.delete(seedMetadata);
		const path = join(dirname(seedMetadata.path), basename(sourceMetadata.path));
		await fs.symlink(sourceMetadata.path, path, "file");
		await repo.open({ ...sourceMetadata, path });
		await fs.unlink(path);
		const destination = await repo.create({ id: "destination", cwd: destinationCwd });
		const metadata = await destination.getMetadata();
		expect(metadata.path).toBe(path);
		expect(metadata.path).not.toBe(sourceMetadata.path);
		expect((await source.appendEntry({ type: "custom", id: "source", customType: "note" }, "main")).seq).toBe(1);
		expect(
			(await destination.appendEntry({ type: "custom", id: "destination", customType: "note" }, "main")).seq,
		).toBe(1);
		for (const [owned, expected] of [
			[sourceMetadata, "source"],
			[metadata, "destination"],
		] as const) {
			const verified = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(owned);
			expect((await verified.findEntries()).map((entry) => entry.id)).toEqual([expected]);
		}
	});

	it.each(["create", "fork"] as const)(
		"does not replace an occupied %s destination discovered at publication",
		async (kind) => {
			const { directory, root, env } = await fixture();
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const source = await repo.create({ id: "source", cwd: directory });
			const metadata = await source.getMetadata();
			const createdAt = 1_700_000_000_000;
			vi.spyOn(Date, "now").mockReturnValue(createdAt);
			const path = join(
				dirname(metadata.path),
				`${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_occupied.jsonl`,
			);
			const preserved = `${JSON.stringify({ kind: "header", version: 4, id: "occupied", createdAt, cwd: directory })}\n`;
			const listDir = env.listDir.bind(env);
			let occupied = false;
			vi.spyOn(env, "listDir").mockImplementation(async (directoryPath, signal) => {
				const snapshot = await listDir(directoryPath, signal);
				if (!occupied) {
					occupied = true;
					await fs.writeFile(path, preserved);
				}
				return snapshot;
			});
			const writing = vi.spyOn(env, "writeFile");
			const renaming = vi.spyOn(env, "renameFile");
			const pending =
				kind === "create"
					? repo.create({ id: "occupied", cwd: directory })
					: repo.fork(metadata, { id: "occupied", cwd: directory });
			await expect(pending).rejects.toMatchObject({ code: "already_exists" });
			expect(writing).not.toHaveBeenCalled();
			expect(renaming).not.toHaveBeenCalled();
			expect(await fs.readFile(path, "utf8")).toBe(preserved);
			await expect(fs.stat(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
});

describe("JSONL detected disk damage", () => {
	it.each(["canonical", "normalized", "directory-alias", "file-alias"] as const)(
		"quarantines a known missing owner through %s and resumes only after valid restoration",
		async (address) => {
			const { directory, root, aliasRoot, env } = await fixture();
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const session = await repo.create({ id: "missing", cwd: directory });
			const metadata = await session.getMetadata();
			await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main");
			let addressed = metadata;
			if (address === "normalized")
				addressed = { ...metadata, path: `${dirname(metadata.path)}/./${basename(metadata.path)}` };
			if (address === "directory-alias") addressed = aliasMetadata(metadata, await fs.realpath(root), aliasRoot);
			if (address === "file-alias") {
				const path = join(directory, "missing-alias.jsonl");
				await fs.symlink(metadata.path, path, "file");
				addressed = { ...metadata, path };
			}
			const alias = await repo.open(addressed);
			const accepted = await fs.readFile(metadata.path, "utf8");
			await fs.unlink(metadata.path);
			await expect(repo.open(addressed)).rejects.toMatchObject({ code: "not_found" });
			const append = vi.spyOn(env, "appendFile");
			await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
			await expect(alias.setName("late")).rejects.toMatchObject({ code: "not_found" });
			await expect(session.createLane("late", null)).rejects.toMatchObject({ code: "not_found" });
			await expect(session.setLabel("kept", "late")).rejects.toMatchObject({ code: "not_found" });
			expect(append).not.toHaveBeenCalled();
			expect((await session.getLog()).map((item) => item.seq)).toEqual([1]);
			await expect(fs.stat(metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
			await fs.writeFile(metadata.path, accepted);
			await repo.open(addressed);
			expect(
				await session.appendEntry({ type: "custom", id: "restored", customType: "note" }, "main"),
			).toMatchObject({ seq: 2, parentId: "kept" });
			const verified = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
			expect((await verified.getLog()).map((item) => item.seq)).toEqual([1, 2]);
		},
	);

	it("retains acknowledged history on prefix damage and accepts exact restored bytes", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "damaged", cwd: directory });
		const metadata = await session.getMetadata();
		await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main");
		const accepted = await fs.readFile(metadata.path, "utf8");
		await fs.writeFile(metadata.path, `${accepted.split("\n")[0]}\n`);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "invalid_entry" });
		expect((await session.getLog()).map((item) => item.seq)).toEqual([1]);
		await fs.writeFile(metadata.path, accepted);
		await repo.open(metadata);
		expect((await session.appendEntry({ type: "custom", id: "next", customType: "note" }, "main")).seq).toBe(2);
	});

	it("does not return a stale owner or delete it when a validated file alias is retargeted to absence", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "retargeted", cwd: directory });
		const metadata = await session.getMetadata();
		const path = join(directory, "alias.jsonl");
		await fs.symlink(metadata.path, path, "file");
		const addressed = { ...metadata, path };
		await repo.open(addressed);
		await fs.unlink(path);
		await fs.symlink(join(directory, "missing-target.jsonl"), path, "file");
		await expect(repo.open(addressed)).rejects.toMatchObject({ code: "not_found" });
		await repo.delete(addressed);
		expect((await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main")).seq).toBe(1);
		expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
		const verified = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
		expect((await verified.findEntries()).map((entry) => entry.id)).toEqual(["kept"]);
	});

	it("keeps real canonical-owner read failures observable during a missing-alias open", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "read-failure", cwd: directory });
		const metadata = await session.getMetadata();
		const path = join(directory, "alias.jsonl");
		await fs.symlink(metadata.path, path, "file");
		const addressed = { ...metadata, path };
		await repo.open(addressed);
		await fs.unlink(path);
		await fs.symlink(join(directory, "missing-target.jsonl"), path, "file");
		const failure = new FileError("permission_denied", "owned read denied", metadata.path);
		const read = vi.spyOn(env, "readTextFile").mockResolvedValueOnce({ ok: false, error: failure });
		await expect(repo.open(addressed)).rejects.toMatchObject({ code: "storage", cause: failure });
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "storage", cause: failure });
		read.mockRestore();
		await repo.open(metadata);
		expect((await session.appendEntry({ type: "custom", id: "resumed", customType: "note" }, "main")).seq).toBe(1);
	});

	it("does not infer a missing-path owner from matching id or cwd", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "unrelated", cwd: directory });
		const metadata = await session.getMetadata();
		const read = vi.spyOn(env, "readTextFile");
		await expect(
			repo.open({ ...metadata, path: join(directory, "unvalidated-missing.jsonl") }),
		).rejects.toMatchObject({ code: "not_found" });
		expect(read).not.toHaveBeenCalled();
		expect((await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main")).seq).toBe(1);
	});
});

describe("JSONL validated alias identity changes", () => {
	it.each(["open", "fork", "delete"] as const)(
		"keeps existing-target canonical not_found strict during %s",
		async (operation) => {
			const { directory, root, env } = await fixture();
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const session = await repo.create({ id: "existing-alias", cwd: directory });
			const metadata = await session.getMetadata();
			const path = join(directory, "alias.jsonl");
			await fs.symlink(metadata.path, path, "file");
			const addressed = { ...metadata, path };
			await repo.open(addressed);
			const failure = new FileError("not_found", "existing target resolution failed", path);
			vi.spyOn(env, "canonicalPath").mockResolvedValueOnce({ ok: false, error: failure });
			const read = vi.spyOn(env, "readTextFile");
			const remove = vi.spyOn(env, "remove");
			const running =
				operation === "open"
					? repo.open(addressed)
					: operation === "fork"
						? repo.fork(addressed, { id: "fork", cwd: directory })
						: repo.delete(addressed);
			await expect(running).rejects.toMatchObject({ code: "not_found", cause: failure });
			expect(read).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect((await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main")).seq).toBe(1);
		},
	);

	it("does not reuse an alias registration after that address becomes a different canonical file", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "replacement", cwd: directory });
		const metadata = await session.getMetadata();
		const header = await fs.readFile(metadata.path, "utf8");
		await session.appendEntry({ type: "custom", id: "original", customType: "note" }, "main");
		const path = join(await fs.realpath(directory), "alias.jsonl");
		await fs.symlink(metadata.path, path, "file");
		const addressed = { ...metadata, path };
		await repo.open(addressed);
		await fs.unlink(path);
		await fs.writeFile(path, header);
		const replacement = await repo.open(addressed);
		expect(
			(await replacement.appendEntry({ type: "custom", id: "replacement", customType: "note" }, "main")).seq,
		).toBe(1);
		expect((await session.findEntries()).map((entry) => entry.id)).toEqual(["original"]);
		await repo.delete(addressed);
		await expect(replacement.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		expect((await session.appendEntry({ type: "custom", id: "next", customType: "note" }, "main")).seq).toBe(2);
		const verified = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
		expect((await verified.getLog()).map((item) => item.seq)).toEqual([1, 2]);
	});
});

describe("JSONL dangling file-alias deletion", () => {
	it.each([false, true])("is idempotent after target deletion (validated alias=%s)", async (validated) => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "deleted-alias", cwd: directory });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("kept");
		const path = join(directory, "file-alias.jsonl");
		await fs.symlink(metadata.path, path, "file");
		const addressed = { ...metadata, path };
		if (validated) await repo.open(addressed);
		await repo.delete(addressed);
		await expect(repo.delete(addressed)).resolves.toBeUndefined();
		expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		expect((await session.getLog()).map((item) => item.seq)).toEqual([1]);
		const live: unknown = Reflect.get(repo, "liveStorages");
		expect(live instanceof Map && live.size).toBe(0);
	});

	it("seals a verified missing canonical owner when deleting a previously validated dangling alias", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "missing-delete", cwd: directory });
		const metadata = await session.getMetadata();
		const path = join(directory, "file-alias.jsonl");
		await fs.symlink(metadata.path, path, "file");
		const addressed = { ...metadata, path };
		await repo.open(addressed);
		await fs.unlink(metadata.path);
		await repo.delete(addressed);
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
	});

	it("does not hide a dangling-alias stat failure or seal its original healthy writer", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "stat-failure", cwd: directory });
		const metadata = await session.getMetadata();
		const path = join(directory, "dangling.jsonl");
		await fs.symlink(join(directory, "missing.jsonl"), path, "file");
		const failure = new FileError("permission_denied", "alias stat denied", path);
		vi.spyOn(env, "fileInfo").mockResolvedValueOnce({ ok: false, error: failure });
		await expect(repo.delete({ ...metadata, path })).rejects.toMatchObject({ code: "storage", cause: failure });
		expect((await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main")).seq).toBe(1);
	});
});

describe("JSONL publication and deletion lifetime", () => {
	it("does not mask an indeterminate existence check after failed canonical resolution", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "indeterminate", cwd: directory });
		const metadata = await session.getMetadata();
		const failure = new FileError("unknown", "existence check failed", metadata.path);
		vi.spyOn(env, "canonicalPath").mockResolvedValueOnce({
			ok: false,
			error: new FileError("not_found", "resolution failed", metadata.path),
		});
		vi.spyOn(env, "exists").mockResolvedValueOnce({ ok: false, error: failure });
		const remove = vi.spyOn(env, "remove");
		await expect(repo.delete(metadata)).rejects.toMatchObject({ code: "storage", cause: failure });
		expect(remove).not.toHaveBeenCalled();
		expect((await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main")).seq).toBe(1);
	});

	it("does not revive old writers when the same file path is created again", async () => {
		const { directory, root, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const old = await repo.create({ id: "generation", cwd: directory });
		const metadata = await old.getMetadata();
		await old.appendEntry({ type: "custom", id: "old", customType: "note" }, "main");
		await repo.delete(metadata);
		const current = await repo.create({ id: "generation", cwd: directory });
		expect((await current.getMetadata()).path).toBe(metadata.path);
		await expect(old.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		expect((await current.appendEntry({ type: "custom", id: "new", customType: "note" }, "main")).seq).toBe(1);
		expect((await old.getLog()).map((item) => (item.kind === "entry" ? item.entry.id : item.kind))).toEqual(["old"]);
		const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
		expect((await replay.getLog()).map((item) => (item.kind === "entry" ? item.entry.id : item.kind))).toEqual([
			"new",
		]);
	});

	it("seals all live mutations after successful aliased deletion but keeps history readable", async () => {
		const { directory, root, aliasRoot, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "deleted", cwd: directory });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("kept");
		await repo.delete(aliasMetadata(metadata, await fs.realpath(root), aliasRoot));
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		await expect(session.setName("late")).rejects.toMatchObject({ code: "not_found" });
		await expect(session.createLane("late", null)).rejects.toMatchObject({ code: "not_found" });
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "not_found" });
		await expect(repo.fork(metadata, { id: "fork", cwd: directory, scope: "tree" })).rejects.toMatchObject({
			code: "not_found",
		});
		expect((await session.getLog()).map((item) => item.seq)).toEqual([1]);
		await repo.delete(metadata);
		await expect(fs.stat(metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await repo.list()).toEqual([]);
	});

	it("orders deletion after an admitted append and rejects later writes", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "pending-append", cwd: directory });
		const metadata = await session.getMetadata();
		const admitted = gate();
		const release = gate();
		const appendFile = env.appendFile.bind(env);
		vi.spyOn(env, "appendFile").mockImplementationOnce(async (path, data) => {
			admitted.resolve();
			await release.promise;
			return appendFile(path, data);
		});
		const append = session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main");
		await admitted.promise;
		const remove = vi.spyOn(env, "remove");
		const canonicalPath = env.canonicalPath.bind(env);
		const deleting = gate();
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
			const result = await canonicalPath(path);
			deleting.resolve();
			return result;
		});
		const deletion = repo.delete(metadata);
		try {
			await deleting.promise;
			await setImmediate();
			expect(remove).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await Promise.all([append, deletion]);
		}
		expect((await append).seq).toBe(1);
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		expect((await session.getLog()).map((item) => item.seq)).toEqual([1]);
		await expect(fs.stat(metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not publish an initial opener after deletion or resurrect the file", async () => {
		const { directory, root, env } = await fixture();
		const original = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).create({
			id: "initial-open",
			cwd: directory,
		});
		const metadata = await original.getMetadata();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const admitted = gate();
		const release = gate();
		const fileInfo = env.fileInfo.bind(env);
		vi.spyOn(env, "fileInfo").mockImplementation(async (path) => {
			const result = await fileInfo(path);
			if (path === metadata.path) {
				admitted.resolve();
				await release.promise;
			}
			return result;
		});
		const opening = repo.open(metadata);
		await admitted.promise;
		const canonicalPath = env.canonicalPath.bind(env);
		const deleting = gate();
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
			const result = await canonicalPath(path);
			deleting.resolve();
			return result;
		});
		const remove = vi.spyOn(env, "remove");
		const deletion = repo.delete(metadata);
		try {
			await deleting.promise;
			await setImmediate();
			expect(remove).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await Promise.all([opening, deletion]);
		}
		await expect((await opening).appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		await expect(fs.stat(metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["create", "fork"] as const)(
		"waits for %s handle publication before opening the published file",
		async (operation) => {
			const { directory, root, env } = await fixture();
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const source = await repo.create({ id: "source", cwd: directory });
			const sourceMetadata = await source.getMetadata();
			const admitted = gate();
			const release = gate();
			let published: JsonlSessionMetadata | undefined;
			const fileInfo = env.fileInfo.bind(env);
			vi.spyOn(env, "fileInfo").mockImplementation(async (path) => {
				const result = await fileInfo(path);
				if (path.endsWith("_publishing.jsonl") && result.ok) {
					const header = JSON.parse((await fs.readFile(path, "utf8")).split("\n")[0]) as { createdAt: number };
					published = {
						id: "publishing",
						cwd: directory,
						path,
						createdAt: header.createdAt,
						modifiedAt: result.value.mtimeMs,
						sourceFormat: 4,
					};
					admitted.resolve();
					await release.promise;
				}
				return result;
			});
			const publication =
				operation === "create"
					? repo.create({ id: "publishing", cwd: directory })
					: repo.fork(sourceMetadata, { id: "publishing", cwd: directory, scope: "tree" });
			await admitted.promise;
			if (!published) throw new Error("Missing published fixture metadata");
			const reading = vi.spyOn(env, "readTextFile");
			const canonicalPath = env.canonicalPath.bind(env);
			const openingAdmitted = gate();
			vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
				const result = await canonicalPath(path);
				openingAdmitted.resolve();
				return result;
			});
			const opening = repo.open(published);
			try {
				await openingAdmitted.promise;
				await setImmediate();
				expect(reading).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await Promise.all([publication, opening]);
			}
			const target = await publication;
			const before = (await target.getLog()).length;
			const first = await target.appendEntry({ type: "custom", id: "first", customType: "note" }, "main");
			const second = await (await opening).appendEntry({ type: "custom", id: "second", customType: "note" }, "main");
			expect(first.seq).toBe(before + 1);
			expect(second).toMatchObject({ seq: before + 2, parentId: first.id });
			const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(published);
			expect((await replay.getLog()).map((item) => item.seq)).toEqual(
				Array.from({ length: before + 2 }, (_, index) => index + 1),
			);
		},
	);

	it("preserves writer and reopen/fork usability after failed deletion", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "delete-failure", cwd: directory });
		const metadata = await session.getMetadata();
		const failure = new FileError("permission_denied", "remove denied", metadata.path);
		vi.spyOn(env, "remove").mockResolvedValueOnce({ ok: false, error: failure });
		await expect(repo.delete(metadata)).rejects.toMatchObject({ code: "storage", cause: failure });
		expect((await session.appendEntry({ type: "custom", id: "first", customType: "note" }, "main")).seq).toBe(1);
		expect(
			(await (await repo.open(metadata)).appendEntry({ type: "custom", id: "second", customType: "note" }, "main"))
				.seq,
		).toBe(2);
		await expect(repo.fork(metadata, { id: "fork", cwd: directory, scope: "tree" })).resolves.toBeDefined();
		await repo.delete(metadata);
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
	});

	it("reclaims idle publication records after successful and failed operations", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		for (let index = 0; index < 20; index++) {
			const session = await repo.create({ id: `reclaim-${index}`, cwd: directory });
			const metadata = await session.getMetadata();
			await Promise.all([repo.open(metadata), repo.open(metadata)]);
			await expect(repo.open({ ...metadata, id: "wrong" })).rejects.toMatchObject({ code: "invalid_entry" });
			await repo.delete(metadata);
			const tails: unknown = Reflect.get(repo, "storageAccessTails");
			expect(tails).toBeInstanceOf(Map);
			expect(tails instanceof Map && tails.size).toBe(0);
		}
	});
});

async function settledWithin(pending: Promise<unknown>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 100);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe("JSONL verified parent identity for missing leaves", () => {
	for (const operation of ["create", "fork"] as const) {
		for (const failureStage of ["none", "write", "committed-stat", "remove"] as const) {
			it(`unvalidated directory alias waits for absent ${operation} publication, failure=${failureStage}`, async () => {
				const { directory, root, aliasRoot, env } = await fixture();
				const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
				const source = await repo.create({ id: "source", cwd: directory });
				await source.appendEntry({ type: "custom", id: "source-entry", customType: "note" }, "main");
				const sourceMetadata = await source.getMetadata();
				const sourceBytes = await fs.readFile(sourceMetadata.path, "utf8");
				const canonicalRoot = await fs.realpath(root);
				const admitted = gate();
				const release = gate();
				let candidate: JsonlSessionMetadata | undefined;
				let statFailed = false;
				const failure = new FileError("permission_denied", `injected ${failureStage} failure`);
				const writeFile = env.writeFile.bind(env);
				vi.spyOn(env, "writeFile").mockImplementation(async (path, content) => {
					if (path.endsWith(operation === "create" ? "_first.jsonl" : "_first.jsonl.tmp")) {
						if (typeof content !== "string") throw new Error("Expected actual encoded JSONL header");
						const header = parseHeader(content.split("\n")[0]);
						if (!header.ok) throw header.error;
						candidate = metadataFromHeader(
							header.value,
							operation === "create" ? path : path.slice(0, -4),
							header.value.createdAt,
						);
						admitted.resolve();
						await release.promise;
						if (failureStage === "write") return { ok: false, error: failure };
					}
					return writeFile(path, content);
				});
				const fileInfo = env.fileInfo.bind(env);
				vi.spyOn(env, "fileInfo").mockImplementation(async (path) => {
					if (failureStage === "committed-stat" && candidate && path === candidate.path && !statFailed) {
						const info = await fileInfo(path);
						if (info.ok) {
							statFailed = true;
							return { ok: false, error: failure };
						}
						return info;
					}
					return fileInfo(path);
				});
				const remove = env.remove.bind(env);
				vi.spyOn(env, "remove").mockImplementation(async (path, options) => {
					if (failureStage === "remove" && candidate && path === candidate.path)
						return { ok: false, error: failure };
					return remove(path, options);
				});
				const publication =
					operation === "create"
						? repo.create({ id: "first", cwd: directory })
						: repo.fork(sourceMetadata, { id: "first", cwd: directory, scope: "tree" });
				const result = publication.then(
					(value) => ({ ok: true as const, value }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				await admitted.promise;
				if (!candidate) throw new Error("Publication gate did not capture real header metadata");
				const addressed = aliasMetadata(candidate, canonicalRoot, aliasRoot);
				await expect(fs.stat(candidate.path)).rejects.toMatchObject({ code: "ENOENT" });
				const deletion = repo.delete(addressed);
				const deletionResult = deletion.then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				try {
					expect(await settledWithin(deletion)).toBe(false);
				} finally {
					release.resolve();
					await Promise.all([result, deletionResult]);
				}
				const outcome = await result;
				if (failureStage === "write" || failureStage === "committed-stat") {
					expect(outcome.ok).toBe(false);
					if (outcome.ok) throw new Error("Injected publication failure unexpectedly succeeded");
					expect(outcome.error).toMatchObject({ code: "storage", cause: failure });
					expect((await deletionResult).ok).toBe(true);
					if (failureStage === "committed-stat") expect(statFailed).toBe(true);
				} else {
					expect(outcome.ok).toBe(true);
					if (!outcome.ok) throw outcome.error;
					const before = (await outcome.value.getLog()).length;
					if (failureStage === "remove") {
						const deleted = await deletionResult;
						expect(deleted.ok).toBe(false);
						if (deleted.ok) throw new Error("Injected deletion failure unexpectedly succeeded");
						expect(deleted.error).toMatchObject({ code: "storage", cause: failure });
						expect(
							(
								await outcome.value.appendEntry(
									{ type: "custom", id: "still-usable", customType: "note" },
									"main",
								)
							).seq,
						).toBe(before + 1);
						await expect(repo.open(candidate)).resolves.toBeDefined();
						vi.restoreAllMocks();
						await repo.delete(addressed);
					}
					await expect(outcome.value.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
					expect((await outcome.value.getLog()).length).toBe(before + (failureStage === "remove" ? 1 : 0));
				}
				await expect(fs.stat(candidate.path)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.stat(`${candidate.path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(candidate)).rejects.toMatchObject({
					code: "not_found",
				});
				expect(await fs.readFile(sourceMetadata.path, "utf8")).toBe(sourceBytes);
				expect(
					(await source.appendEntry({ type: "custom", id: "source-later", customType: "note" }, "main")).seq,
				).toBe(2);
			});
		}
	}

	for (const spelling of ["ordinary", "backslash-parent", "backslash-leaf"] as const) {
		it(`missing open quarantines a verified live owner through new alias, ${spelling}`, async () => {
			const { directory, root, env } = await fixture();
			const sessionsRoot = spelling === "backslash-parent" ? join(directory, "sessions\\literal") : root;
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
			let session = await repo.create({ id: "owner", cwd: directory });
			await session.appendEntry({ type: "custom", id: "accepted", customType: "note" }, "main");
			let metadata = await session.getMetadata();
			if (spelling === "backslash-leaf") {
				const renamed = join(dirname(metadata.path), "literal\\leaf.jsonl");
				await fs.rename(metadata.path, renamed);
				await repo.delete(metadata);
				session = await repo.open({ ...metadata, path: renamed });
				metadata = await session.getMetadata();
			}
			const aliasDirectory = join(directory, "unvalidated alias 😀");
			await fs.symlink(dirname(metadata.path), aliasDirectory, "dir");
			const addressed = { ...metadata, path: join(aliasDirectory, basename(metadata.path)) };
			const bytes = await fs.readFile(metadata.path, "utf8");
			await fs.unlink(metadata.path);
			const appending = vi.spyOn(env, "appendFile");
			await expect(repo.open(addressed)).rejects.toMatchObject({ code: "not_found" });
			await expect(
				session.appendEntry({ type: "custom", id: "late", customType: "note" }, "main"),
			).rejects.toMatchObject({ code: "not_found" });
			expect(appending).not.toHaveBeenCalled();
			await expect(fs.stat(metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await session.findEntries()).map((entry) => entry.id)).toEqual(["accepted"]);
			await fs.writeFile(metadata.path, bytes);
			const restored = await repo.open(addressed);
			expect((await restored.appendEntry({ type: "custom", id: "restored", customType: "note" }, "main")).seq).toBe(
				2,
			);
			expect((await session.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
				"accepted",
				"restored",
			]);
			const fresh = await new JsonlSessionRepo({ fs: env, sessionsRoot }).open(metadata);
			expect((await fresh.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
				"accepted",
				"restored",
			]);
		});
	}

	for (const operation of ["open", "delete"] as const) {
		for (const failureStage of [
			"canonical-permission",
			"canonical-not-found",
			"stat",
			"not-directory",
			"address-join",
			"canonical-join",
		] as const) {
			it(`${operation} preserves strict parent-proof failure ${failureStage}`, async () => {
				const { directory, root, env } = await fixture();
				const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
				const session = await repo.create({ id: "proof", cwd: directory });
				await session.appendEntry({ type: "custom", id: "accepted", customType: "note" }, "main");
				const metadata = await session.getMetadata();
				const bytes = await fs.readFile(metadata.path, "utf8");
				const aliasParent = join(directory, "proof-alias");
				await fs.symlink(dirname(metadata.path), aliasParent, "dir");
				const addressed = { ...metadata, path: join(aliasParent, basename(metadata.path)) };
				await fs.unlink(metadata.path);
				const code = failureStage === "canonical-not-found" ? "not_found" : "permission_denied";
				const failure = new FileError(code, `parent ${failureStage}`, aliasParent);
				const canonicalPath = env.canonicalPath.bind(env);
				let canonicalFailures = 0;
				const canonical = vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
					if (
						path === aliasParent &&
						(failureStage === "canonical-permission" || failureStage === "canonical-not-found") &&
						canonicalFailures++ === 0
					)
						return { ok: false, error: failure };
					return canonicalPath(path);
				});
				const fileInfo = env.fileInfo.bind(env);
				vi.spyOn(env, "fileInfo").mockImplementation(async (path) => {
					if (path === dirname(metadata.path) && failureStage === "stat") return { ok: false, error: failure };
					const info = await fileInfo(path);
					if (path === dirname(metadata.path) && failureStage === "not-directory" && info.ok)
						return { ok: true, value: { ...info.value, kind: "file" } };
					return info;
				});
				const joinPath = env.joinPath.bind(env);
				vi.spyOn(env, "joinPath").mockImplementation(async (parts) => {
					if (
						(failureStage === "address-join" && parts[0].startsWith(aliasParent)) ||
						(failureStage === "canonical-join" && parts[0] === dirname(metadata.path))
					)
						return { ok: false, error: failure };
					return joinPath(parts);
				});
				const removing = vi.spyOn(env, "remove");
				const pending = operation === "open" ? repo.open(addressed) : repo.delete(addressed);
				await expect(pending).rejects.toMatchObject(
					failureStage === "not-directory"
						? { code: "storage" }
						: { code: code === "not_found" ? "not_found" : "storage", cause: failure },
				);
				expect(removing).not.toHaveBeenCalled();
				if (failureStage === "canonical-not-found")
					expect(canonical.mock.calls.filter(([path]) => path === aliasParent)).toHaveLength(2);
				vi.restoreAllMocks();
				await fs.writeFile(metadata.path, bytes);
				expect((await session.appendEntry({ type: "custom", id: "usable", customType: "note" }, "main")).seq).toBe(
					2,
				);
			});
		}
	}

	it("never quarantines a same-ID owner in another physical parent", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const first = await repo.create({ id: "same", cwd: join(directory, "first") });
		const other = await repo.create({ id: "same", cwd: join(directory, "other") });
		const metadata = await other.getMetadata();
		const aliasParent = join(directory, "other-alias");
		await fs.symlink(dirname(metadata.path), aliasParent, "dir");
		await fs.unlink(metadata.path);
		await expect(repo.open({ ...metadata, path: join(aliasParent, basename(metadata.path)) })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(other.appendCustomEntry("quarantined")).rejects.toMatchObject({ code: "not_found" });
		expect((await first.appendEntry({ type: "custom", id: "unrelated", customType: "note" }, "main")).seq).toBe(1);
	});

	it("missing deletion in a separate parent does not drain an unrelated publication", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const unrelated = await repo.create({ id: "unrelated", cwd: join(directory, "unrelated") });
		const metadata = await unrelated.getMetadata();
		const missing = { ...metadata, id: "missing", path: join(dirname(metadata.path), "missing.jsonl") };
		const admitted = gate();
		const release = gate();
		const writeFile = env.writeFile.bind(env);
		vi.spyOn(env, "writeFile").mockImplementation(async (path, content) => {
			if (path.endsWith("_blocked.jsonl")) {
				admitted.resolve();
				await release.promise;
			}
			return writeFile(path, content);
		});
		const creating = repo.create({ id: "blocked", cwd: join(directory, "blocked") });
		await admitted.promise;
		const deleting = repo.delete(missing);
		try {
			expect(await settledWithin(deleting)).toBe(true);
		} finally {
			release.resolve();
			await Promise.all([creating, deleting]);
		}
		expect((await unrelated.appendEntry({ type: "custom", id: "unrelated", customType: "note" }, "main")).seq).toBe(
			1,
		);
		expect(
			(await (await creating).appendEntry({ type: "custom", id: "created", customType: "note" }, "main")).seq,
		).toBe(1);
	});

	for (const parentKind of ["absent", "dangling"] as const) {
		it(`keeps missing deletion idempotent when its parent is independently ${parentKind}`, async () => {
			const { directory, root, env } = await fixture();
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const session = await repo.create({ id: "source", cwd: directory });
			const metadata = await session.getMetadata();
			const parent = join(directory, "absent-parent");
			if (parentKind === "dangling") await fs.symlink(join(directory, "absent-target"), parent, "dir");
			await repo.delete({ ...metadata, path: join(parent, "missing.jsonl") });
			if (parentKind === "dangling") expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
			expect(
				(await session.appendEntry({ type: "custom", id: "still-usable", customType: "note" }, "main")).seq,
			).toBe(1);
		});
	}

	it.each([
		["/leaf.jsonl", "/", "/physical", "/physical/leaf.jsonl", "posix"],
		["C:\\leaf.jsonl", "C:\\", "D:\\", "D:\\leaf.jsonl", "win32"],
		[
			"\\\\server\\share\\leaf.jsonl",
			"\\\\server\\share\\",
			"\\\\server\\physical\\",
			"\\\\server\\physical\\leaf.jsonl",
			"win32",
		],
	] as const)(
		"preserves root parent proof for %s (synthetic path capability, not runtime certification)",
		async (path, parent, canonicalParent, expected, flavor) => {
			const { root, env } = await fixture();
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			vi.spyOn(env, "absolutePath").mockImplementation(async (input) => ({
				ok: true,
				value: (flavor === "win32" ? win32 : posix).resolve(input),
			}));
			vi.spyOn(env, "joinPath").mockImplementation(async (parts) => ({
				ok: true,
				value: (flavor === "win32" ? win32 : posix).join(...parts),
			}));
			const canonical = vi.spyOn(env, "canonicalPath").mockResolvedValue({ ok: true, value: canonicalParent });
			vi.spyOn(env, "fileInfo").mockResolvedValue({
				ok: true,
				value: { name: "parent", path: canonicalParent, kind: "directory", size: 0, mtimeMs: 0 },
			});
			const resolve: unknown = Reflect.get(repo, "resolveMissingPath");
			if (typeof resolve !== "function") throw new Error("Missing private prospective identity owner");
			expect(await resolve.call(repo, path)).toEqual({ path: expected, directory: canonicalParent });
			expect(canonical).toHaveBeenCalledExactlyOnceWith(parent);
		},
	);

	it("does not invent physical identity for an unsupported namespace or a failed path round trip", async () => {
		const { root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const canonical = vi.spyOn(env, "canonicalPath");
		vi.spyOn(env, "joinPath").mockResolvedValue({ ok: true, value: "different namespace address" });
		const resolve: unknown = Reflect.get(repo, "resolveMissingPath");
		if (typeof resolve !== "function") throw new Error("Missing private prospective identity owner");
		expect(await resolve.call(repo, "volume|parent|leaf.jsonl")).toEqual({ path: "volume|parent|leaf.jsonl" });
		expect(await resolve.call(repo, "/parent/leaf.jsonl")).toEqual({ path: "/parent/leaf.jsonl" });
		expect(canonical).not.toHaveBeenCalled();
	});
});

describe("JSONL retargeted parent and native case publication", () => {
	for (const state of [
		"live-current",
		"no-current",
		"both-missing",
		"wrong-id",
		"parent-error",
		"case-alias",
	] as const) {
		it(`missing known directory alias uses proved current ownership: ${state}`, async () => {
			const { directory, root, env } = await fixture();
			vi.spyOn(Date, "now").mockReturnValue(1);
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const old = await repo.create({ id: "Same", cwd: join(directory, "old") });
			const oldMetadata = await old.getMetadata();
			const oldBytes = await fs.readFile(oldMetadata.path, "utf8");
			const current = await repo.create({ id: "Same", cwd: join(directory, "current") });
			const currentMetadata = await current.getMetadata();
			await current.appendEntry({ type: "custom", id: "accepted", customType: "note" }, "main");
			const currentBytes = await fs.readFile(currentMetadata.path, "utf8");
			const alias = join(directory, "validated-parent-alias");
			await fs.symlink(dirname(state === "case-alias" ? currentMetadata.path : oldMetadata.path), alias, "dir");
			const name =
				state === "case-alias"
					? basename(currentMetadata.path).replace("_Same.jsonl", "_same.jsonl")
					: basename(oldMetadata.path);
			const addressed = { ...(state === "case-alias" ? currentMetadata : oldMetadata), path: join(alias, name) };
			// Native case equivalence is measured while the file exists; no platform guess.
			if (state === "case-alias") {
				const resolved = await env.canonicalPath(addressed.path);
				if (!resolved.ok) {
					expect(resolved.error.code).toBe("not_found");
					// A case-sensitive native volume has no such alias; ordinary spelling remains valid.
					addressed.path = join(alias, basename(currentMetadata.path));
				} else expect(resolved.value).toBe(currentMetadata.path);
			}
			await repo.open(addressed);
			if (state !== "case-alias") {
				await fs.unlink(alias);
				await fs.symlink(dirname(currentMetadata.path), alias, "dir");
			}
			if (state === "no-current") await repo.delete(currentMetadata);
			else await fs.unlink(currentMetadata.path);
			if (state === "both-missing") await fs.unlink(oldMetadata.path);
			const failure = new FileError("permission_denied", "current parent proof denied", alias);
			const canonicalPath = env.canonicalPath.bind(env);
			if (state === "parent-error")
				vi.spyOn(env, "canonicalPath").mockImplementation(async (path) =>
					path === alias ? { ok: false, error: failure } : canonicalPath(path),
				);
			const metadata = state === "wrong-id" ? { ...addressed, id: "wrong" } : addressed;
			await expect(repo.open(metadata)).rejects.toMatchObject(
				state === "wrong-id"
					? { code: "invalid_entry" }
					: state === "parent-error"
						? { code: "storage", cause: failure }
						: { code: "not_found" },
			);
			vi.restoreAllMocks();
			if (state === "live-current" || state === "both-missing" || state === "case-alias") {
				await expect(current.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
				expect((await current.findEntries()).map((entry) => entry.id)).toEqual(["accepted"]);
				await expect(fs.stat(currentMetadata.path)).rejects.toMatchObject({ code: "ENOENT" });
				await fs.writeFile(currentMetadata.path, currentBytes);
				await repo.open(addressed);
				expect(
					(await current.appendEntry({ type: "custom", id: "restored", customType: "note" }, "main")).seq,
				).toBe(2);
				const fresh = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(currentMetadata);
				expect((await fresh.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
					"accepted",
					"restored",
				]);
			} else if (state !== "no-current") {
				await fs.writeFile(currentMetadata.path, currentBytes);
				expect(
					(await current.appendEntry({ type: "custom", id: "not-quarantined", customType: "note" }, "main")).seq,
				).toBe(2);
			}
			if (state === "both-missing") await fs.writeFile(oldMetadata.path, oldBytes);
			expect((await old.appendEntry({ type: "custom", id: "old-usable", customType: "note" }, "main")).seq).toBe(1);
		});
	}

	for (const pair of [
		["create", "create"],
		["create", "fork"],
		["fork", "fork"],
	] as const) {
		for (const secondTime of [1, 2]) {
			it(`${pair.join("/")} native case variants: directory alias and timestamp=${secondTime}`, async () => {
				const { directory, root, env } = await fixture();
				const clock = vi.spyOn(Date, "now").mockReturnValue(1);
				const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
				const seed = await repo.create({ id: "seed", cwd: directory });
				await seed.appendEntry({ type: "custom", id: "seed-entry", customType: "note" }, "main");
				const seedMetadata = await seed.getMetadata();
				const sourceBytes = await fs.readFile(seedMetadata.path, "utf8");
				const otherCwd = join(directory, "aliased-cwd");
				const aliasSeed = await repo.create({ id: "alias-seed", cwd: otherCwd });
				const aliasSeedMetadata = await aliasSeed.getMetadata();
				await repo.delete(aliasSeedMetadata);
				await fs.rmdir(dirname(aliasSeedMetadata.path));
				await fs.symlink(dirname(seedMetadata.path), dirname(aliasSeedMetadata.path), "dir");
				const admitted = gate();
				const release = gate();
				const writeFile = env.writeFile.bind(env);
				vi.spyOn(env, "writeFile").mockImplementation(async (path, content) => {
					if (path.endsWith(pair[0] === "create" ? "_CASE.jsonl" : "_CASE.jsonl.tmp")) {
						admitted.resolve();
						await release.promise;
					}
					return writeFile(path, content);
				});
				const first =
					pair[0] === "create"
						? repo.create({ id: "CASE", cwd: directory })
						: repo.fork(seedMetadata, { id: "CASE", cwd: directory, scope: "tree" });
				await admitted.promise;
				clock.mockReturnValue(secondTime);
				const competing =
					pair[1] === "create"
						? repo.create({ id: "case", cwd: otherCwd })
						: repo.fork(seedMetadata, { id: "case", cwd: otherCwd, scope: "tree" });
				const result = competing.then(
					(value) => ({ ok: true as const, value }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				try {
					expect(await settledWithin(competing)).toBe(false);
				} finally {
					release.resolve();
					await Promise.all([first, result]);
				}
				const published = await first;
				const metadata = await published.getMetadata();
				const nativeVariant = await env.canonicalPath(metadata.path.replace("_CASE.jsonl", "_case.jsonl"));
				const samePhysicalTarget = secondTime === 1 && nativeVariant.ok && nativeVariant.value === metadata.path;
				const outcome = await result;
				expect(outcome.ok).toBe(!samePhysicalTarget);
				if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "already_exists" });
				else {
					const otherMetadata = await outcome.value.getMetadata();
					expect(otherMetadata.id).toBe("case");
					expect(JSON.parse((await fs.readFile(otherMetadata.path, "utf8")).split("\n")[0]).id).toBe("case");
					const before = (await outcome.value.getLog()).length;
					expect(
						(await outcome.value.appendEntry({ type: "custom", id: "other", customType: "note" }, "main")).seq,
					).toBe(before + 1);
					await expect(
						new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(otherMetadata),
					).resolves.toBeDefined();
				}
				expect(metadata.id).toBe("CASE");
				expect(JSON.parse((await fs.readFile(metadata.path, "utf8")).split("\n")[0]).id).toBe("CASE");
				const before = (await published.getLog()).length;
				expect((await published.appendEntry({ type: "custom", id: "first", customType: "note" }, "main")).seq).toBe(
					before + 1,
				);
				await expect(new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata)).resolves.toBeDefined();
				expect(await fs.readFile(seedMetadata.path, "utf8")).toBe(sourceBytes);
			});
		}
	}

	it("failed directory publication releases for a case-variant creator without folding IDs", async () => {
		const { directory, root, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const admitted = gate();
		const release = gate();
		const writeFile = env.writeFile.bind(env);
		const failure = new FileError("unknown", "first publication failed");
		vi.spyOn(env, "writeFile").mockImplementation(async (path, content) => {
			if (path.endsWith("_CASE.jsonl")) {
				admitted.resolve();
				await release.promise;
				return { ok: false, error: failure };
			}
			return writeFile(path, content);
		});
		const first = repo.create({ id: "CASE", cwd: directory });
		const firstResult = first.then(
			() => undefined,
			(error: unknown) => error,
		);
		await admitted.promise;
		const second = repo.create({ id: "case", cwd: directory });
		try {
			expect(await settledWithin(second)).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([firstResult, second]);
		}
		expect(await firstResult).toMatchObject({ code: "storage", cause: failure });
		expect((await (await second).getMetadata()).id).toBe("case");
		await expect(
			new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(await (await second).getMetadata()),
		).resolves.toBeDefined();
	});

	it("same-file alias deletion and competing case publication take directory before file without deadlock", async () => {
		const { directory, root, aliasRoot, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const admitted = gate();
		const release = gate();
		let candidate: JsonlSessionMetadata | undefined;
		const writeFile = env.writeFile.bind(env);
		vi.spyOn(env, "writeFile").mockImplementation(async (path, content) => {
			if (path.endsWith("_CASE.jsonl")) {
				if (typeof content !== "string") throw new Error("Expected actual header");
				const header = parseHeader(content.split("\n")[0]);
				if (!header.ok) throw header.error;
				candidate = metadataFromHeader(header.value, path, header.value.createdAt);
				admitted.resolve();
				await release.promise;
			}
			return writeFile(path, content);
		});
		const first = repo.create({ id: "CASE", cwd: directory });
		await admitted.promise;
		if (!candidate) throw new Error("Missing actual admitted candidate");
		const checkAdmitted = gate();
		const checkRelease = gate();
		let occupied: boolean | undefined;
		const exists = env.exists.bind(env);
		vi.spyOn(env, "exists").mockImplementation(async (path) => {
			const result = await exists(path);
			if (path.endsWith("_case.jsonl")) {
				if (!result.ok) throw new Error("Actual occupancy fixture failed");
				occupied = result.value;
				checkAdmitted.resolve();
				await checkRelease.promise;
			}
			return result;
		});
		const second = repo.create({ id: "case", cwd: directory });
		const secondResult = second.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		release.resolve();
		const published = await first;
		await checkAdmitted.promise;
		const removing = vi.spyOn(env, "remove");
		const deletion = repo.delete(aliasMetadata(candidate, await fs.realpath(root), aliasRoot));
		try {
			expect(await settledWithin(deletion)).toBe(false);
			expect(removing).not.toHaveBeenCalled();
		} finally {
			checkRelease.resolve();
			await Promise.all([secondResult, deletion]);
		}
		await expect(published.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		const outcome = await secondResult;
		expect(outcome.ok).toBe(!occupied);
		if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "already_exists" });
		else {
			const metadata = await outcome.value.getMetadata();
			const native = await env.canonicalPath(metadata.path);
			// A case-sensitive volume retains the independently published lowercase file.
			expect(native.ok).toBe(true);
			expect(
				(await outcome.value.appendEntry({ type: "custom", id: "independent", customType: "note" }, "main")).seq,
			).toBe(1);
		}
		const tails: unknown = Reflect.get(repo, "storageAccessTails");
		expect(tails instanceof Map && tails.size).toBe(0);
	});
});

describe("JSONL admitted identity freshness", () => {
	it("seals the current native generation after a held successful canonical deletion receipt", async () => {
		const { directory, root, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const old = await repo.create({ id: "CASE", cwd: directory });
		const metadata = await old.getMetadata();
		const lowerPath = metadata.path.replace("_CASE.jsonl", "_case.jsonl");
		const nativeAlias = await env.canonicalPath(lowerPath);
		if (!nativeAlias.ok) expect(nativeAlias.error.code).toBe("not_found");
		else {
			const [a, b] = await Promise.all([fs.stat(metadata.path), fs.stat(lowerPath)]);
			expect([a.dev, a.ino]).toEqual([b.dev, b.ino]);
		}
		const admitted = gate();
		const release = gate();
		const canonicalPath = env.canonicalPath.bind(env);
		let held = false;
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
			const actual = await canonicalPath(path);
			if (!held && path === metadata.path && actual.ok) {
				held = true;
				expect(actual.value).toBe(metadata.path);
				admitted.resolve();
				await release.promise;
			}
			return actual;
		});
		const deletion = repo.delete(metadata);
		await admitted.promise;
		try {
			await repo.delete(metadata);
			await expect(old.appendCustomEntry("old-sealed")).rejects.toMatchObject({ code: "not_found" });
			const replacement = await repo.create({ id: "case", cwd: directory });
			const current = await replacement.getMetadata();
			expect(current.path).toBe(lowerPath);
			expect((await replacement.appendEntry({ type: "custom", id: "before", customType: "note" }, "main")).seq).toBe(
				1,
			);
			release.resolve();
			await deletion;
			if (nativeAlias.ok) {
				await expect(replacement.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
				await expect(fs.stat(current.path)).rejects.toMatchObject({ code: "ENOENT" });
				expect((await replacement.getLog()).map((item) => item.seq)).toEqual([1]);
			} else {
				// Native distinct filenames retain supported case-only allocation.
				expect(
					(await replacement.appendEntry({ type: "custom", id: "after", customType: "note" }, "main")).seq,
				).toBe(2);
				const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(current);
				expect((await replay.getLog()).map((item) => item.seq)).toEqual([1, 2]);
			}
		} finally {
			release.resolve();
			await Promise.allSettled([deletion]);
		}
		const tails: unknown = Reflect.get(repo, "storageAccessTails");
		expect(tails instanceof Map && tails.size).toBe(0);
	});

	it("redirects stale successful open identity without replaying a still-unpublished native creator", async () => {
		const { directory, root, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const historical = await repo.create({ id: "case", cwd: directory });
		const metadata = await historical.getMetadata();
		const upperPath = metadata.path.replace("_case.jsonl", "_CASE.jsonl");
		const nativeAlias = await env.canonicalPath(upperPath);
		if (!nativeAlias.ok) expect(nativeAlias.error.code).toBe("not_found");
		else {
			const [a, b] = await Promise.all([fs.stat(metadata.path), fs.stat(upperPath)]);
			expect([a.dev, a.ino]).toEqual([b.dev, b.ino]);
		}
		await repo.delete(metadata);
		const upper = await repo.create({ id: "CASE", cwd: directory });
		const upperMetadata = await upper.getMetadata();
		if (!nativeAlias.ok) {
			await expect(repo.open(metadata)).rejects.toMatchObject({ code: "not_found" });
			expect((await upper.appendEntry({ type: "custom", id: "distinct", customType: "note" }, "main")).seq).toBe(1);
			return;
		}
		const canonicalEntered = gate();
		const canonicalRelease = gate();
		const publicationEntered = gate();
		const publicationRelease = gate();
		const progressed = gate();
		const canonicalPath = env.canonicalPath.bind(env);
		const fileInfo = env.fileInfo.bind(env);
		const readTextFile = env.readTextFile.bind(env);
		let heldCanonical = false;
		let holdPublication = false;
		let heldPublication = false;
		let creatorPublished = false;
		let staleReplay = false;
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
			const actual = await canonicalPath(path);
			if (path === metadata.path && actual.ok) {
				if (!heldCanonical) {
					heldCanonical = true;
					expect(actual.value).toBe(upperMetadata.path);
					canonicalEntered.resolve();
					await canonicalRelease.promise;
				} else if (actual.value === metadata.path) progressed.resolve();
			}
			return actual;
		});
		vi.spyOn(env, "fileInfo").mockImplementation(async (path) => {
			const actual = await fileInfo(path);
			if (holdPublication && !heldPublication && path === metadata.path && actual.ok) {
				heldPublication = true;
				publicationEntered.resolve();
				await publicationRelease.promise;
			}
			return actual;
		});
		vi.spyOn(env, "readTextFile").mockImplementation(async (path) => {
			const actual = await readTextFile(path);
			if (path === upperMetadata.path && actual.ok && !creatorPublished) {
				staleReplay = true;
				progressed.resolve();
			}
			return actual;
		});
		const opening = repo.open(metadata);
		await canonicalEntered.promise;
		await repo.delete(upperMetadata);
		holdPublication = true;
		const creating = repo.create({ id: "case", cwd: directory }).then((session) => {
			creatorPublished = true;
			return session;
		});
		await publicationEntered.promise;
		try {
			const [a, b] = await Promise.all([fs.stat(metadata.path), fs.stat(upperMetadata.path)]);
			expect([a.dev, a.ino]).toEqual([b.dev, b.ino]);
			canonicalRelease.resolve();
			// Positive actual-current receipt or actual wrong replay is the oracle,
			// not a timed absence of completion under a held publication.
			await progressed.promise;
			expect(staleReplay).toBe(false);
			publicationRelease.resolve();
			const [opened, created] = await Promise.all([opening, creating]);
			expect((await opened.getMetadata()).path).toBe((await created.getMetadata()).path);
			expect((await opened.appendEntry({ type: "custom", id: "opened", customType: "note" }, "main")).seq).toBe(1);
			expect((await created.appendEntry({ type: "custom", id: "created", customType: "note" }, "main")).seq).toBe(2);
			const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(await created.getMetadata());
			expect((await replay.getLog()).map((item) => item.seq)).toEqual([1, 2]);
		} finally {
			canonicalRelease.resolve();
			publicationRelease.resolve();
			await Promise.allSettled([opening, creating]);
		}
		const tails: unknown = Reflect.get(repo, "storageAccessTails");
		expect(tails instanceof Map && tails.size).toBe(0);
	});

	it.each(["both-missing", "old-healthy", "no-current"] as const)(
		"deletion selects current proved parent, not historical weak alias: %s",
		async (state) => {
			const { directory, root, env } = await fixture();
			vi.spyOn(Date, "now").mockReturnValue(1);
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const old = await repo.create({ id: "Same", cwd: join(directory, "old") });
			const current = await repo.create({ id: "Same", cwd: join(directory, "current") });
			const oldMetadata = await old.getMetadata();
			const currentMetadata = await current.getMetadata();
			await old.appendEntry({ type: "custom", id: "old", customType: "note" }, "main");
			await current.appendEntry({ type: "custom", id: "current", customType: "note" }, "main");
			const oldBytes = await fs.readFile(oldMetadata.path, "utf8");
			const alias = join(directory, "moving-parent");
			await fs.symlink(dirname(oldMetadata.path), alias, "dir");
			const addressed = { ...oldMetadata, path: join(alias, basename(oldMetadata.path)) };
			await repo.open(addressed);
			await fs.unlink(alias);
			await fs.symlink(dirname(currentMetadata.path), alias, "dir");
			if (state === "no-current") await repo.delete(currentMetadata);
			else await fs.unlink(currentMetadata.path);
			if (state !== "old-healthy") await fs.unlink(oldMetadata.path);
			// Deliberately no missing open before this delete.
			await repo.delete(addressed);
			if (state !== "old-healthy") await fs.writeFile(oldMetadata.path, oldBytes);
			expect(
				(await old.appendEntry({ type: "custom", id: "historical-still-usable", customType: "note" }, "main")).seq,
			).toBe(2);
			await expect(current.appendCustomEntry("current-late")).rejects.toMatchObject({ code: "not_found" });
			expect((await current.getLog()).map((item) => item.seq)).toEqual([1]);
			const replay = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(oldMetadata);
			expect((await replay.getLog()).map((item) => item.seq)).toEqual([1, 2]);
			const tails: unknown = Reflect.get(repo, "storageAccessTails");
			expect(tails instanceof Map && tails.size).toBe(0);
		},
	);

	for (const action of ["open", "delete"] as const) {
		it.each(["permission_denied", "unknown"] as const)(
			`keeps actual admission canonical failures strict for ${action}: %s`,
			async (code) => {
				const { directory, root, env } = await fixture();
				const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
				const session = await repo.create({ id: "stable", cwd: directory });
				await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main");
				const metadata = await session.getMetadata();
				const before = await fs.readFile(metadata.path, "utf8");
				const failure = new FileError(code, "current admission canonical denied", metadata.path);
				const canonicalPath = env.canonicalPath.bind(env);
				let calls = 0;
				vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
					if (path === metadata.path && ++calls === 2) return { ok: false, error: failure };
					return canonicalPath(path);
				});
				await expect(action === "open" ? repo.open(metadata) : repo.delete(metadata)).rejects.toMatchObject({
					code: "storage",
					cause: failure,
				});
				expect(await fs.readFile(metadata.path, "utf8")).toBe(before);
				vi.restoreAllMocks();
				expect((await session.appendEntry({ type: "custom", id: "usable", customType: "note" }, "main")).seq).toBe(
					2,
				);
				const tails: unknown = Reflect.get(repo, "storageAccessTails");
				expect(tails instanceof Map && tails.size).toBe(0);
			},
		);
	}

	it("checks current deletion parent proof inside directory admission and preserves a rejected owner", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "parent-proof", cwd: directory });
		const metadata = await session.getMetadata();
		const parent = dirname(metadata.path);
		const failure = new FileError("permission_denied", "admitted parent stat denied", parent);
		const fileInfo = env.fileInfo.bind(env);
		let calls = 0;
		vi.spyOn(env, "fileInfo").mockImplementation(async (path) => {
			if (path === parent && ++calls === 2) return { ok: false, error: failure };
			return fileInfo(path);
		});
		await expect(repo.delete(metadata)).rejects.toMatchObject({ code: "storage", cause: failure });
		vi.restoreAllMocks();
		expect((await session.appendEntry({ type: "custom", id: "preserved", customType: "note" }, "main")).seq).toBe(1);
		const tails: unknown = Reflect.get(repo, "storageAccessTails");
		expect(tails instanceof Map && tails.size).toBe(0);
	});

	it("quarantines a verified owner after a successful open receipt becomes genuinely missing at admission", async () => {
		const { directory, root, env } = await fixture();
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "vanished", cwd: directory });
		await session.appendEntry({ type: "custom", id: "kept", customType: "note" }, "main");
		const metadata = await session.getMetadata();
		const before = await fs.readFile(metadata.path, "utf8");
		const canonicalPath = env.canonicalPath.bind(env);
		let held = false;
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
			const actual = await canonicalPath(path);
			if (!held && path === metadata.path && actual.ok) {
				held = true;
				await fs.unlink(metadata.path);
			}
			return actual;
		});
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "not_found" });
		await expect(session.appendCustomEntry("late")).rejects.toMatchObject({ code: "not_found" });
		await expect(fs.stat(metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
		await fs.writeFile(metadata.path, before);
		await repo.open(metadata);
		expect((await session.appendEntry({ type: "custom", id: "restored", customType: "note" }, "main")).seq).toBe(2);
		const tails: unknown = Reflect.get(repo, "storageAccessTails");
		expect(tails instanceof Map && tails.size).toBe(0);
	});

	it("revalidates fork source identity without changing the live source snapshot policy", async () => {
		const { directory, root, env } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const old = await repo.create({ id: "Shared", cwd: join(directory, "old") });
		const current = await repo.create({ id: "Shared", cwd: join(directory, "current") });
		await old.appendEntry({ type: "custom", id: "old-kept", customType: "note" }, "main");
		await current.appendEntry({ type: "custom", id: "current-kept", customType: "note" }, "main");
		const oldMetadata = await old.getMetadata();
		const currentMetadata = await current.getMetadata();
		const alias = join(directory, "source-alias");
		await fs.symlink(dirname(oldMetadata.path), alias, "dir");
		const addressed = { ...oldMetadata, path: join(alias, basename(oldMetadata.path)) };
		const canonicalPath = env.canonicalPath.bind(env);
		let held = false;
		vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
			const actual = await canonicalPath(path);
			if (!held && path === addressed.path && actual.ok) {
				held = true;
				expect(actual.value).toBe(oldMetadata.path);
				await fs.unlink(alias);
				await fs.symlink(dirname(currentMetadata.path), alias, "dir");
			}
			return actual;
		});
		const read = vi.spyOn(env, "readTextFile");
		const fork = await repo.fork(addressed, {
			id: "destination",
			cwd: join(directory, "destination"),
			scope: "tree",
		});
		expect((await fork.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual(["current-kept"]);
		expect(read.mock.calls.filter(([path]) => path === oldMetadata.path || path === currentMetadata.path)).toEqual(
			[],
		);
		expect((await old.appendEntry({ type: "custom", id: "old-next", customType: "note" }, "main")).seq).toBe(2);
		expect((await current.appendEntry({ type: "custom", id: "current-next", customType: "note" }, "main")).seq).toBe(
			2,
		);
		const tails: unknown = Reflect.get(repo, "storageAccessTails");
		expect(tails instanceof Map && tails.size).toBe(0);
	});

	it.each(["open", "delete"] as const)(
		"fails bounded identity churn for %s before mutation/publication and releases all queues",
		async (action) => {
			const { directory, root, env } = await fixture();
			vi.spyOn(Date, "now").mockReturnValue(1);
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const sessions = await Promise.all(
				["a", "b", "c"].map((cwd) => repo.create({ id: "Shared", cwd: join(directory, cwd) })),
			);
			const metadata = await Promise.all(sessions.map((session) => session.getMetadata()));
			const bytes = await Promise.all(metadata.map((item) => fs.readFile(item.path, "utf8")));
			const first = metadata[0];
			if (!first) throw new Error("Missing real first metadata");
			const alias = join(directory, "churning-parent");
			await fs.symlink(dirname(first.path), alias, "dir");
			const addressed = { ...first, path: join(alias, basename(first.path)) };
			const canonicalPath = env.canonicalPath.bind(env);
			let calls = 0;
			vi.spyOn(env, "canonicalPath").mockImplementation(async (path) => {
				const actual = await canonicalPath(path);
				if (path === addressed.path && actual.ok) {
					const next = metadata[++calls % metadata.length];
					if (!next) throw new Error("Missing real next metadata");
					await fs.unlink(alias);
					await fs.symlink(dirname(next.path), alias, "dir");
				}
				return actual;
			});
			await expect(action === "open" ? repo.open(addressed) : repo.delete(addressed)).rejects.toMatchObject({
				code: "storage",
				message: expect.stringContaining("changed during admission"),
			});
			expect(calls).toBeLessThanOrEqual(4);
			expect(await Promise.all(metadata.map((item) => fs.readFile(item.path, "utf8")))).toEqual(bytes);
			const tails: unknown = Reflect.get(repo, "storageAccessTails");
			expect(tails instanceof Map && tails.size).toBe(0);
			vi.restoreAllMocks();
			for (const [index, session] of sessions.entries())
				expect(
					(await session.appendEntry({ type: "custom", id: `healthy-${index}`, customType: "note" }, "main")).seq,
				).toBe(1);
		},
	);
});
