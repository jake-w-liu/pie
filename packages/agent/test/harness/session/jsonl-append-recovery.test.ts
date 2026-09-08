import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/index.ts";
import { FileError } from "../../../src/harness/types.ts";

const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-jsonl-append-recovery-"));
	roots.push(root);
	const env = new NodeExecutionEnv({ cwd: root });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
	return { root, env, repo };
}

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("JSONL append acknowledgement recovery", () => {
	it.each(["zero", "prefix", "multibyte", "complete"] as const)(
		"rolls back a %s write-then-error before acknowledging queued mutations",
		async (written) => {
			const { root, env, repo } = fixture();
			const session = await repo.create({ id: "source", cwd: root });
			await session.appendCustomEntry("anchor", "雪");
			const metadata = await session.getMetadata();
			const prefix = readFileSync(metadata.path, "utf8");
			const failed = new FileError("unknown", "injected append failure");
			const rename = vi.spyOn(env, "renameFile");
			vi.spyOn(env, "appendFile").mockImplementationOnce(async (path, data) => {
				const bytes = Buffer.from(data);
				const length =
					written === "zero"
						? 0
						: written === "complete"
							? bytes.length
							: written === "multibyte"
								? bytes.indexOf("雪") + 1
								: 15;
				appendFileSync(path, bytes.subarray(0, length));
				return { ok: false, error: failed };
			});

			const rejected = expect(session.appendCustomEntry("unacknowledged", "雪")).rejects.toMatchObject({
				code: "storage",
				cause: failed,
			});
			const accepted = session.appendEntry({ type: "custom", id: "accepted", customType: "note" }, "main");
			await rejected;
			const entry = await accepted;
			expect(entry.seq).toBe(2);
			expect(rename).toHaveBeenCalledTimes(written === "zero" ? 0 : 1);
			expect(readFileSync(metadata.path, "utf8").startsWith(prefix)).toBe(true);
			await session.setName("after recovery");
			const reopened = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
			expect(await reopened.getLog()).toEqual(await session.getLog());
			expect(await reopened.getEntry("accepted")).toEqual(entry);
			expect(
				(await reopened.findEntries()).some(
					(item) => item.type === "custom" && item.customType === "unacknowledged",
				),
			).toBe(false);
		},
	);

	it.each(["read", "stage", "rename", "corrupt-prefix"] as const)(
		"rejects later admission when append recovery fails at %s",
		async (failure) => {
			const { root, env, repo } = fixture();
			const session = await repo.create({ id: "source", cwd: root });
			await session.appendCustomEntry("anchor");
			const metadata = await session.getMetadata();
			const original = readFileSync(metadata.path, "utf8");
			const appendError = new FileError("unknown", "injected append failure");
			const repairError = new FileError("permission_denied", "injected recovery failure");
			const append = vi.spyOn(env, "appendFile").mockImplementationOnce(async (path) => {
				if (failure === "corrupt-prefix") writeFileSync(path, original.replace("anchor", "broken"));
				appendFileSync(path, '{"kind":"entry"');
				return { ok: false, error: appendError };
			});
			if (failure === "read") vi.spyOn(env, "readTextFile").mockResolvedValueOnce({ ok: false, error: repairError });
			if (failure === "stage") {
				vi.spyOn(env, "writeFile").mockImplementationOnce(async (path) => {
					writeFileSync(path, "partial recovery file");
					return { ok: false, error: repairError };
				});
			}
			if (failure === "rename") vi.spyOn(env, "renameFile").mockResolvedValueOnce({ ok: false, error: repairError });

			const rejected = expect(session.appendCustomEntry("unacknowledged")).rejects.toMatchObject({
				cause: appendError,
			});
			const queued = expect(session.setName("must reject")).rejects.toMatchObject({ code: "storage" });
			await rejected;
			await queued;
			await expect(session.appendCustomEntry("also rejected")).rejects.toMatchObject({ code: "storage" });
			await expect(repo.fork(metadata, { id: "fork", cwd: root, scope: "tree" })).rejects.toMatchObject({
				code: "storage",
			});
			expect(append).toHaveBeenCalledTimes(1);
			expect(await session.getName()).toBeUndefined();
			expect(existsSync(`${metadata.path}.tmp`)).toBe(false);
			expect(readFileSync(metadata.path, "utf8")).toBe(
				`${failure === "corrupt-prefix" ? original.replace("anchor", "broken") : original}{"kind":"entry"`,
			);
			if (failure !== "corrupt-prefix") {
				const restored = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
				expect(await restored.getLog()).toEqual(await session.getLog());
				await restored.appendCustomEntry("after reopen");
				expect((await restored.getLog()).map((item) => item.seq)).toEqual([1, 2]);
			}
		},
	);

	it.each(["unterminated", "torn"] as const)(
		"retains the repaired %s prefix as the acknowledgement boundary",
		async (tail) => {
			const { root, env, repo } = fixture();
			const original = await repo.create({ id: "source", cwd: root });
			await original.appendCustomEntry("anchor", "雪");
			const metadata = await original.getMetadata();
			const prefix = readFileSync(metadata.path, "utf8");
			writeFileSync(metadata.path, tail === "unterminated" ? prefix.slice(0, -1) : `${prefix}{"kind":`);
			const session = await repo.open(metadata);
			vi.spyOn(env, "appendFile").mockImplementationOnce(async (path, data) => {
				appendFileSync(path, data);
				return { ok: false, error: new FileError("unknown", "complete write failed") };
			});
			await expect(session.setName("unacknowledged")).rejects.toMatchObject({ code: "storage" });
			expect(readFileSync(metadata.path, "utf8")).toBe(prefix);
			await session.setName("accepted");
			const reopened = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
			expect(await reopened.getLog()).toEqual(await session.getLog());
			expect(await reopened.getName()).toBe("accepted");
		},
	);

	it.each(["create", "open", "fork"] as const)(
		"snapshots the live %s storage without repairing an in-flight append",
		async (owner) => {
			const { root, env, repo } = fixture();
			let source = await repo.create({ id: "source", cwd: root });
			await source.appendMessage({ role: "user", content: "anchor", timestamp: 1 });
			if (owner === "open") source = await repo.open(await source.getMetadata());
			if (owner === "fork") source = await repo.fork(await source.getMetadata(), { id: "first-fork", cwd: root });
			const metadata = await source.getMetadata();
			const written = gate();
			const release = gate();
			const forkPrepared = gate();
			const createDir = env.createDir.bind(env);
			vi.spyOn(env, "createDir").mockImplementation(async (...args) => {
				const result = await createDir(...args);
				forkPrepared.resolve();
				return result;
			});
			const rename = vi.spyOn(env, "renameFile");
			vi.spyOn(env, "appendFile").mockImplementationOnce(async (path, data) => {
				const handle = await open(path, "a");
				try {
					const bytes = Buffer.from(data);
					await handle.write(bytes.subarray(0, 15));
					written.resolve();
					await release.promise;
					await handle.write(bytes.subarray(15));
					return { ok: true, value: undefined };
				} finally {
					await handle.close();
				}
			});
			const append = source.appendMessage({ role: "user", content: "concurrent", timestamp: 2 });
			await written.promise;
			const fork = repo.fork(metadata, { id: "snapshot", cwd: root });
			try {
				await forkPrepared.promise;
				expect(rename.mock.calls.some(([, destination]) => destination === metadata.path)).toBe(false);
			} finally {
				release.resolve();
				await Promise.all([append, fork]);
			}
			const id = await append;
			const snapshot = await fork;
			const reopened = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(metadata);
			expect(await reopened.getEntry(id)).toEqual(await source.getEntry(id));
			// Forks allocate a new sequence, omitting the source's lane/fact mutations.
			expect((await snapshot.findEntriesOnBranch()).map(({ seq: _seq, ...entry }) => entry)).toEqual(
				(await source.findEntriesOnBranch()).map(({ seq: _seq, ...entry }) => entry),
			);
			const reopenedFork = await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).open(
				await snapshot.getMetadata(),
			);
			expect(await reopenedFork.getLog()).toEqual(await snapshot.getLog());
		},
	);
});
