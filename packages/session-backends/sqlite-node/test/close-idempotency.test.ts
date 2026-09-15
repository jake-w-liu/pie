import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

function createCloseCountingSqliteFactory() {
	const source = createNodeSqliteFactory();
	const counts = { opens: 0, closes: 0 };
	return {
		counts,
		sqlite: {
			async open(path: string) {
				const db = await source.open(path);
				counts.opens += 1;
				return {
					exec: (sql: string) => db.exec(sql),
					prepare: (sql: string) => db.prepare(sql),
					transaction: <T>(fn: () => T): T => db.transaction(fn),
					close() {
						counts.closes += 1;
						db.close();
					},
				};
			},
		},
	};
}

describe("SQLite repository close idempotency (D2)", () => {
	it("shares one close sequence across concurrent close() calls", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const { counts, sqlite } = createCloseCountingSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		await repo.create({ cwd: root, id: "session-1" });

		await Promise.all([repo.close(), repo.close(), repo.close()]);

		expect(counts.closes).toBe(1);
		// A subsequent close after completion stays idempotent.
		await repo.close();
		expect(counts.closes).toBe(1);
	});
});
