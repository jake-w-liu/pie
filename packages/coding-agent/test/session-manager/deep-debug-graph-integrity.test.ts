import crypto from "node:crypto";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildContextEntries,
	buildSessionContext,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";

const directories: string[] = [];
const timestamp = "2020-01-01T00:00:00Z";
const fullId = "abcdef01-0000-4000-8000-000000000001";
const nextFullId = "abcdef01-0000-4000-8000-000000000002";

function fixture(entries: unknown[], version = 3) {
	const directory = mkdtempSync(join(tmpdir(), "pi-session-graph-"));
	directories.push(directory);
	const path = join(directory, "session.jsonl");
	const header = { type: "session", id: "source", cwd: directory, timestamp, version };
	const bytes = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	writeFileSync(path, bytes);
	return { directory, path, bytes };
}

function custom(id: string, parentId: string | null): SessionEntry {
	return { type: "custom", id, parentId, timestamp, customType: "fixture" };
}

function mockUuidCollision() {
	let calls = 0;
	const random = vi.spyOn(crypto, "randomUUID").mockImplementation(() => (++calls <= 101 ? fullId : nextFullId));
	syncBuiltinESMExports();
	return random;
}

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("collision-checked session entry allocation", () => {
	it.each(["open", "fork"] as const)(
		"reserves migrated short IDs during %s and preserves compaction targets",
		(route) => {
			const { directory, path, bytes } = fixture(
				[
					{ type: "message", timestamp, message: { role: "user", content: "old", timestamp: 1 } },
					{ type: "message", timestamp, message: { role: "user", content: "kept", timestamp: 2 } },
					{ type: "compaction", timestamp, summary: "summary", tokensBefore: 42, firstKeptEntryIndex: 2 },
				],
				1,
			);
			vi.spyOn(crypto, "randomUUID")
				.mockReturnValueOnce("12345678-0000-4000-8000-000000000001")
				.mockReturnValueOnce("12345678-0000-4000-8000-000000000002")
				.mockReturnValueOnce("abcdef01-0000-4000-8000-000000000003")
				.mockReturnValueOnce("fedcba98-0000-4000-8000-000000000004");
			syncBuiltinESMExports();
			const manager =
				route === "open"
					? SessionManager.open(path)
					: SessionManager.forkFrom(path, directory, join(directory, "forks"), { id: "fork" });
			const entries = manager.getEntries();
			// Prove uniqueness before any traversal: the old allocator generates a cycle.
			expect(entries.map((entry) => entry.id)).toEqual(["12345678", "abcdef01", "fedcba98"]);
			expect(entries.map((entry) => entry.parentId)).toEqual([null, "12345678", "abcdef01"]);
			expect(entries[2]).toMatchObject({ type: "compaction", firstKeptEntryId: "abcdef01" });
			expect(entries[2]).not.toHaveProperty("firstKeptEntryIndex");
			expect(manager.getBranch()).toHaveLength(3);
			expect(manager.buildSessionContext().messages).toMatchObject([
				{ role: "compactionSummary" },
				{ role: "user", content: "kept" },
			]);
			if (route === "fork") expect(readFileSync(path, "utf8")).toBe(bytes);
			const destination = manager.getSessionFile();
			if (!destination) throw new Error("Missing persisted fixture destination");
			expect(SessionManager.open(destination).getBranch()).toEqual(manager.getBranch());
		},
	);

	it("checks full-UUID collisions after exhausting the short-ID retry policy", () => {
		const { path } = fixture([custom(fullId, null), custom("abcdef01", fullId)]);
		const manager = SessionManager.open(path);
		const random = mockUuidCollision();
		expect(manager.appendCustomEntry("next")).toBe(nextFullId);
		expect(random).toHaveBeenCalledTimes(102);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual([fullId, "abcdef01", nextFullId]);
		expect(manager.getBranch()).toHaveLength(3);
		expect(SessionManager.open(path).getBranch()).toEqual(manager.getBranch());
	});

	it("reports complete allocator exhaustion without changing memory or disk", () => {
		const { path, bytes } = fixture([custom(fullId, null), custom("abcdef01", fullId)]);
		const manager = SessionManager.open(path);
		const before = manager.getEntries();
		const random = vi.spyOn(crypto, "randomUUID").mockReturnValue(fullId);
		syncBuiltinESMExports();
		expect(() => manager.appendCustomEntry("failed")).toThrow(/unique session entry ID/);
		expect(random).toHaveBeenCalledTimes(200);
		expect(manager.getEntries()).toEqual(before);
		expect(manager.getLeafId()).toBe("abcdef01");
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});
});

const invalidGraphs = [
	{ name: "self cycle", entries: [custom("a", "a")] },
	{ name: "two-node cycle", entries: [custom("a", "b"), custom("b", "a")] },
	{ name: "unselected cyclic component", entries: [custom("a", "b"), custom("b", "a"), custom("root", null)] },
	{ name: "duplicate IDs", entries: [custom("a", null), custom("a", null)] },
	{ name: "empty ID", entries: [custom("", null)] },
	{ name: "missing ID", entries: [{ type: "custom", parentId: null, timestamp, customType: "fixture" }] },
	{ name: "non-string ID", entries: [{ type: "custom", id: 5, parentId: null, timestamp, customType: "fixture" }] },
	{ name: "invalid parent ID", entries: [{ type: "custom", id: "a", parentId: 5, timestamp, customType: "fixture" }] },
];

describe("private graph validation before publication", () => {
	for (const version of [2, 3]) {
		it.each(invalidGraphs)(`rejects $name in v${version} without rewriting corrupt source bytes`, ({ entries }) => {
			const { path, bytes } = fixture(entries, version);
			expect(() => SessionManager.open(path)).toThrow(/Invalid session graph/);
			expect(readFileSync(path, "utf8")).toBe(bytes);
		});
	}

	it.each(invalidGraphs)("rejects fork of $name before publishing a destination", ({ entries }) => {
		const { directory, path, bytes } = fixture(entries, 2);
		expect(() => SessionManager.forkFrom(path, directory, directory, { id: "fork" })).toThrow(
			/Invalid session graph/,
		);
		expect(readdirSync(directory)).toEqual(["session.jsonl"]);
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("keeps the old published session owner after a failed switch", () => {
		const valid = fixture([custom("kept", null)]);
		const invalid = fixture([custom("cycle", "cycle")], 2);
		const manager = SessionManager.open(valid.path);
		const before = {
			id: manager.getSessionId(),
			path: manager.getSessionFile(),
			header: manager.getHeader(),
			entries: manager.getEntries(),
			leaf: manager.getLeafId(),
		};
		expect(() => manager.setSessionFile(invalid.path)).toThrow(/Invalid session graph/);
		expect({
			id: manager.getSessionId(),
			path: manager.getSessionFile(),
			header: manager.getHeader(),
			entries: manager.getEntries(),
			leaf: manager.getLeafId(),
		}).toEqual(before);
		expect(manager.getBranch().map((entry) => entry.id)).toEqual(["kept"]);
		manager.appendCustomEntry("next");
		expect(SessionManager.open(valid.path).getBranch()).toHaveLength(2);
		expect(readFileSync(invalid.path, "utf8")).toBe(invalid.bytes);
	});

	it.each(["empty", "migrated"] as const)("retains the old owner when %s candidate publication fails", (mode) => {
		const valid = fixture([custom("kept", null)]);
		const candidate = fixture([custom("candidate", null)], 2);
		if (mode === "empty") writeFileSync(candidate.path, "");
		const bytes = mode === "empty" ? "" : candidate.bytes;
		const manager = SessionManager.open(valid.path);
		const before = {
			path: manager.getSessionFile(),
			header: manager.getHeader(),
			entries: manager.getEntries(),
			leaf: manager.getLeafId(),
		};
		const failure = new Error("candidate rename failed");
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw failure;
		});
		syncBuiltinESMExports();
		expect(() => manager.setSessionFile(candidate.path)).toThrow(failure);
		expect({
			path: manager.getSessionFile(),
			header: manager.getHeader(),
			entries: manager.getEntries(),
			leaf: manager.getLeafId(),
		}).toEqual(before);
		expect(manager.getBranch().map((entry) => entry.id)).toEqual(["kept"]);
		expect(readFileSync(candidate.path, "utf8")).toBe(bytes);
		expect(readdirSync(candidate.directory)).toEqual(["session.jsonl"]);
	});

	it("retains orphan roots, arbitrary nonempty IDs, unknown-leaf semantics and explicit null leaves", () => {
		const first = custom("path / 😀", "missing-parent");
		const second = custom(" ", first.id);
		const { path } = fixture([first, second]);
		const manager = SessionManager.open(path);
		expect(manager.getBranch()).toEqual([first, second]);
		expect(manager.getTree()).toMatchObject([{ entry: first, children: [{ entry: second }] }]);
		expect(manager.getBranch("unknown-leaf")).toEqual([]);
		expect(buildContextEntries([first, second], "unknown-leaf")).toEqual([first, second]);
		expect(buildContextEntries([first, second], null)).toEqual([]);
	});

	it("validates a deep reverse-ordered graph with near-linear lookup work and no depth cap", () => {
		const count = 30_000;
		const entries = Array.from({ length: count }, (_, index) =>
			custom(`deep-node-${index}`, index === 0 ? null : `deep-node-${index - 1}`),
		).reverse();
		const { path } = fixture(entries);
		const get = Map.prototype.get;
		let lookups = 0;
		const spy = vi.spyOn(Map.prototype, "get").mockImplementation(function (
			this: Map<unknown, unknown>,
			key: unknown,
		) {
			if (typeof key === "string" && key.startsWith("deep-node-")) lookups++;
			return get.call(this, key);
		});
		const manager = SessionManager.open(path);
		spy.mockRestore();
		expect(lookups).toBeGreaterThanOrEqual(count - 1);
		expect(lookups).toBeLessThanOrEqual(count * 2);
		manager.branch(`deep-node-${count - 1}`);
		expect(manager.getBranch()).toHaveLength(count);
		expect(manager.buildContextEntries()).toHaveLength(count);
	});
});

class WatchdogMap extends Map<string, SessionEntry> {
	lookups = 0;
	override get(id: string): SessionEntry | undefined {
		if (++this.lookups > 8) throw new Error("fixture watchdog interrupted repeated parent lookup");
		return super.get(id);
	}
}

describe("parent walkers defend independently of load validation", () => {
	for (const size of [1, 2]) {
		it.each(["context", "entries", "branch"] as const)(
			`fails %s on a ${size}-node cycle before the bounded watchdog`,
			(route) => {
				const entries = [custom("a", size === 1 ? "a" : "b")];
				if (size === 2) entries.push(custom("b", "a"));
				const index = new WatchdogMap(entries.map((entry) => [entry.id, entry]));
				const manager = SessionManager.inMemory("/tmp", { id: "fixture" });
				Reflect.set(manager, "byId", index);
				const action =
					route === "context"
						? () => buildSessionContext(entries, "a", index)
						: route === "entries"
							? () => buildContextEntries(entries, "a", index)
							: () => manager.getBranch("a");
				expect(action).toThrow(/Invalid session graph.*cycle/);
				expect(index.lookups).toBeLessThan(9);
			},
		);
	}
});
