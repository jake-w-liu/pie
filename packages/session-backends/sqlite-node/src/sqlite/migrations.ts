import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "./sql.ts";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteMigration {
	id: string;
	order: number;
	sql: string;
}

async function loadMigrationSql(relativePath: string): Promise<string> {
	return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

export async function loadMigrations(): Promise<SqliteMigration[]> {
	return [
		{
			id: "001_initial.sql",
			order: 1,
			sql: await loadMigrationSql("./migrations/001_initial.sql"),
		},
	];
}

function ensureMigrationsTable(db: SqliteDatabase): void {
	sql`
CREATE TABLE IF NOT EXISTS migrations (
	id TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
);
`.exec(db);
}

export async function applyMigrations(db: SqliteDatabase): Promise<void> {
	ensureMigrationsTable(db);
	const migrations = await loadMigrations();
	// Read the applied-migration set inside the same BEGIN IMMEDIATE write
	// transaction that applies them. Two processes racing to first-open a fresh DB
	// used to both read an empty applied set outside the transaction; the second
	// then hit a raw UNIQUE constraint failure on migrations.id after the first
	// committed. BEGIN IMMEDIATE serializes writers, so a waiter reads the first
	// process's committed migrations and skips them.
	db.transaction(() => {
		const appliedRows = sql`SELECT id FROM migrations ORDER BY applied_at, id`.all<{ id: string }>(db);
		const applied = new Set(appliedRows.map((row) => row.id));

		for (const migration of migrations) {
			if (applied.has(migration.id)) continue;
			db.exec(migration.sql);
			sql`INSERT INTO migrations (id, applied_at) VALUES (${migration.id}, ${new Date().toISOString()})`.run(db);
			applied.add(migration.id);
		}
	});
}
