import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, type SqliteDatabaseFactory, SqliteSessionRepository } from "../src/index.ts";
import { appendEntryToBranchCache } from "../src/sqlite/branch-cache.ts";
import { insertEntryRow } from "../src/sqlite/storage/entries.ts";
import { appendFact } from "../src/sqlite/storage/facts.ts";
import { setLaneLeaf } from "../src/sqlite/storage/lanes.ts";
import { getNextSequence, setNextSequence } from "../src/sqlite/storage/session-sequences.ts";
import { incrementMessageCount } from "../src/sqlite/storage/session-stats.ts";
import { createTempDir, createUserMessage } from "./test-utils.ts";

describe("SQLite fork snapshots", () => {
	it.each([
		["metadata", "delete"],
		["entries", "delete"],
		["metadata", "append"],
		["entries", "append"],
	] as const)("holds one snapshot when a second connection tries to %s/%s", async (boundary, mutation) => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using sourceRepo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const source = await sourceRepo.create({ id: "source", cwd: root, metadata: { version: "before" } });
		const rootId = await source.appendMessage(createUserMessage("before"));
		await source.createLane("thread", rootId);
		await source.setName("before");
		await source.setLabel(rootId, "before-label");
		const sourceMetadata = await source.getMetadata();
		const expectedEntries = await source.findEntriesOnBranch();

		// A real second connection commits at the exact read boundary. Its transaction uses
		// the same canonical entry/cache/fact writes as an append, or the complete deletion.
		const writer = await sqlite.open(databasePath);
		writer.exec("PRAGMA busy_timeout=0");
		const mutate = () =>
			writer.transaction(() => {
				if (mutation === "delete") {
					for (const table of [
						"branch_entries",
						"branch_tips",
						"facts",
						"lane_moves",
						"lanes",
						"records",
						"entries",
						"writer_leases",
						"session_stats",
						"session_sequences",
					]) {
						writer.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run("source");
					}
					writer.prepare("DELETE FROM sessions WHERE id = ?").run("source");
					return;
				}
				const seq = getNextSequence(writer, "source");
				insertEntryRow(writer, "source", {
					seq,
					id: "concurrent",
					parentId: rootId,
					type: "message",
					timestamp: 2,
					payload: JSON.stringify({ message: createUserMessage("after") }),
				});
				setLaneLeaf(writer, "source", "main", "concurrent");
				appendEntryToBranchCache(writer, "source", "concurrent", seq, "message", null, rootId);
				incrementMessageCount(writer, "source");
				appendFact(writer, "source", seq + 1, "name", null, JSON.stringify("after"));
				appendFact(writer, "source", seq + 2, "label", rootId, JSON.stringify("after-label"));
				setNextSequence(writer, "source", seq + 3);
				writer
					.prepare("UPDATE sessions SET metadata = ? WHERE id = ?")
					.run(JSON.stringify({ version: "after" }), "source");
			});
		let attempted = false;
		let concurrentError: unknown;
		let armed = false;
		const afterRead = (query: string, params: unknown[]) => {
			if (!armed || attempted || params[0] !== "source") return;
			if (!(boundary === "metadata" ? query.includes("FROM sessions AS s") : /FROM entries\s+WHERE/.test(query)))
				return;
			attempted = true;
			try {
				mutate();
			} catch (error) {
				concurrentError = error;
			}
		};
		const instrumented: SqliteDatabaseFactory = {
			async open(path) {
				const db = await sqlite.open(path);
				return {
					exec: (query) => db.exec(query),
					transaction: (fn) => db.transaction(fn),
					close: () => db.close(),
					prepare(query) {
						const statement = db.prepare(query);
						return {
							run: (...params) => statement.run(...params),
							iterate: <TRow extends object>(...params: unknown[]) => statement.iterate<TRow>(...params),
							get<TRow extends object>(...params: unknown[]) {
								const row = statement.get<TRow>(...params);
								afterRead(query, params);
								return row;
							},
							all<TRow extends object>(...params: unknown[]) {
								const rows = statement.all<TRow>(...params);
								afterRead(query, params);
								return rows;
							},
						};
					},
				};
			},
		};
		try {
			await using forkRepo = new SqliteSessionRepository({ env, sqlite: instrumented, databasePath });
			await forkRepo.list();
			armed = true;
			const fork = await forkRepo.fork(sourceMetadata, { id: "fork", cwd: root, scope: "tree" });
			expect(attempted).toBe(true);
			expect(await fork.getLanes()).toEqual([
				{ lane: "main", leafId: rootId },
				{ lane: "thread", leafId: rootId },
			]);
			expect(await fork.findEntriesOnBranch()).toEqual(expectedEntries);
			expect(await fork.view("thread").findEntriesOnBranch()).toEqual(expectedEntries);
			expect(await fork.getName()).toBe("before");
			expect(await fork.getLabel(rootId)).toBe("before-label");
			expect((await fork.getMetadata()).metadata).toEqual({ version: "before" });
			expect(await fork.getStats()).toMatchObject({ messageCount: 1, totalTokens: 0 });
			expect(concurrentError).toMatchObject({ errcode: 5 }); // SQLITE_BUSY: BEGIN IMMEDIATE protects all reads.
			mutate(); // The same second-connection write succeeds once fork publication commits.
			if (mutation === "append") expect(await source.getLeafId()).toBe("concurrent");
			else expect(writer.prepare("SELECT id FROM sessions WHERE id = ?").get("source")).toBeUndefined();
			const forkMetadata = await fork.getMetadata();
			const log = await fork.getLog();
			await forkRepo.close();
			await using reopenedRepo = new SqliteSessionRepository({ env, sqlite, databasePath });
			const reopened = await reopenedRepo.open(forkMetadata);
			expect(await reopened.getLog()).toEqual(log);
			expect(await reopened.getLeafId()).toBe(rootId);
			expect(await reopened.findEntriesOnBranch()).toEqual(expectedEntries);
			const appendedId = await reopened.appendMessage(createUserMessage("fork continues"));
			expect((await reopened.getEntry(appendedId))?.parentId).toBe(rootId);
		} finally {
			writer.close();
		}
	});
});
