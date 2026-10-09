import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

describe("audit persistence fixes (P1/P3/P4/E6)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function appendUserAndAssistant(session: SessionManager): void {
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	function strayTempFiles(): string[] {
		return readdirSync(tempDir).filter((name) => name.endsWith(".tmp"));
	}

	it("E6: reports malformed lines with file and line number instead of skipping silently", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"this is not json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const seen: Array<{ filePath: string; lineNumber: number; line: string }> = [];
		const entries = loadEntriesFromFile(file, {
			onMalformedLine: (info) => {
				seen.push(info);
			},
		});
		expect(entries).toHaveLength(2);
		expect(seen).toHaveLength(1);
		expect(seen[0].lineNumber).toBe(2);
		expect(seen[0].filePath).toBe(file);
		expect(seen[0].line).toBe("this is not json");
	});

	it("E6: warns on stderr by default and stays silent for blank lines", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const file = join(tempDir, "blanks.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"\n" +
				"   \n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(warn).not.toHaveBeenCalled();

		const corrupt = join(tempDir, "corrupt.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		writeFileSync(corrupt, `${readFileSync(file, "utf-8")}broken { json\n`);
		expect(loadEntriesFromFile(corrupt)).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("line 2");
	});

	it("E6: silent option suppresses the report", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const file = join(tempDir, "quiet.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\nbroken\n');
		expect(loadEntriesFromFile(file, { silent: true })).toHaveLength(1);
		expect(warn).not.toHaveBeenCalled();
	});

	it("P1: rewrite path round-trips every entry and leaves no temp files", () => {
		const session = SessionManager.create(tempDir, tempDir);
		appendUserAndAssistant(session);

		// Branching writes the complete candidate through the shared atomic writer.
		const leafId = session.getLeafId();
		if (!leafId) throw new Error("Expected leaf id");
		const branchedFile = session.createBranchedSession(leafId);
		if (!branchedFile) throw new Error("Expected branched session file");
		const entries = loadEntriesFromFile(branchedFile, { silent: true });
		expect(entries.length).toBe(3);
		expect(entries[0].type).toBe("session");
		expect(strayTempFiles()).toEqual([]);
	});

	it("P3: a pre-created session file no longer fails first flush with EEXIST", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");
		// Simulate a concurrent process/migration creating the file first.
		writeFileSync(sessionFile, "");

		expect(() => appendUserAndAssistant(session)).not.toThrow();
		const entries = loadEntriesFromFile(sessionFile, { silent: true });
		// Header + user + assistant appended instead of dropped.
		expect(entries.length).toBe(3);
		expect(entries[0].type).toBe("session");
		expect(strayTempFiles()).toEqual([]);
	});

	it("P4: fork writes the complete file atomically", () => {
		const session = SessionManager.create(tempDir, tempDir);
		appendUserAndAssistant(session);
		const sourceFile = session.getSessionFile();
		if (!sourceFile) throw new Error("Expected persisted session file");
		const sourceCount = loadEntriesFromFile(sourceFile, { silent: true }).length;
		expect(sourceCount).toBe(3);

		const forked = SessionManager.forkFrom(sourceFile, tempDir, tempDir);
		const forkedFile = forked.getSessionFile();
		if (!forkedFile) throw new Error("Expected forked session file");
		const forkedEntries = loadEntriesFromFile(forkedFile, { silent: true });
		// New header + all copied non-header entries: never a header-only file.
		expect(forkedEntries.length).toBe(sourceCount);
		expect(forkedEntries[0].type).toBe("session");
		expect(strayTempFiles()).toEqual([]);
	});

	it("P4: fork with a colliding explicit id still fails instead of overwriting", () => {
		const session = SessionManager.create(tempDir, tempDir);
		appendUserAndAssistant(session);
		const sourceFile = session.getSessionFile();
		if (!sourceFile) throw new Error("Expected persisted session file");

		SessionManager.forkFrom(sourceFile, tempDir, tempDir, { id: "audit-fixed-fork-id" });
		// A second fork to the same explicit id must not silently replace the first.
		// (Both forks land in the same second; if the timestamp prefix differs the
		// target name differs and no collision occurs — either outcome is safe.)
		try {
			SessionManager.forkFrom(sourceFile, tempDir, tempDir, { id: "audit-fixed-fork-id" });
		} catch (error) {
			expect((error as NodeJS.ErrnoException).code).toBe("EEXIST");
		}
	});
});

describe("SDK branch publication ownership", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-branch-publication-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function assistant(text: string) {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "offline-branch-fixture",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function capture(manager: SessionManager) {
		return {
			id: manager.getSessionId(),
			path: manager.getSessionFile(),
			header: manager.getHeader(),
			entries: manager.getEntries(),
			leaf: manager.getLeafId(),
			tree: manager.getTree(),
			branch: manager.getBranch(),
			context: manager.buildSessionContext(),
			name: manager.getSessionName(),
			count: manager.getEntryCount(),
			cwd: manager.getCwd(),
			directory: manager.getSessionDir(),
		};
	}

	function flushedFixture(data: unknown = { stored: true }) {
		const manager = SessionManager.create(tempDir, tempDir, { id: "original-owner" });
		const firstUser = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const custom = manager.appendCustomEntry("serializable", data);
		const firstAssistant = manager.appendMessage(assistant("first reply"));
		manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		const laterAssistant = manager.appendMessage(assistant("later reply"));
		const retainedLabel = manager.appendLabelChange(firstAssistant, "retained label");
		manager.appendLabelChange(laterAssistant, "later label");
		manager.appendSessionInfo("original name");
		manager.appendCustomEntry("tail", { retained: true });
		return { manager, firstUser, custom, firstAssistant, laterAssistant, retainedLabel };
	}

	it.each(["write", "rename", "serialization"] as const)(
		"retains the complete flushed owner after actual %s failure, then appends to it and retries",
		(fault) => {
			const failure = Object.assign(new Error(`branch ${fault} failed`), { code: "EIO" });
			let failSerialization = false;
			let serializations = 0;
			const data =
				fault === "serialization"
					? {
							toJSON() {
								serializations++;
								if (failSerialization) throw failure;
								return { stored: true };
							},
						}
					: { stored: true };
			const { manager, firstAssistant, laterAssistant } = flushedFixture(data);
			const before = capture(manager);
			if (!before.path) throw new Error("Expected persisted original path");
			const bytes = readFileSync(before.path, "utf8");
			const files = readdirSync(tempDir);
			const callsBefore = serializations;
			const write =
				fault === "write"
					? vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
							throw failure;
						})
					: undefined;
			const rename =
				fault === "rename"
					? vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
							throw failure;
						})
					: undefined;
			failSerialization = fault === "serialization";
			syncBuiltinESMExports();
			let observed: unknown;
			try {
				manager.createBranchedSession(firstAssistant);
			} catch (error) {
				observed = error;
			}
			expect(observed).toBe(failure);
			if (write) expect(write).toHaveBeenCalledTimes(1);
			if (rename) expect(rename).toHaveBeenCalledTimes(1);
			if (fault === "serialization") expect(serializations).toBe(callsBefore + 1);
			expect(capture(manager)).toEqual(before);
			expect(manager.getLabel(firstAssistant)).toBe("retained label");
			expect(manager.getLabel(laterAssistant)).toBe("later label");
			expect(readFileSync(before.path, "utf8")).toBe(bytes);
			expect(readdirSync(tempDir)).toEqual(files);
			write?.mockRestore();
			rename?.mockRestore();
			failSerialization = false;
			syncBuiltinESMExports();

			const appended = manager.appendCustomEntry("after-failure", { actual: true });
			expect(manager.getSessionId()).toBe(before.id);
			expect(manager.getSessionFile()).toBe(before.path);
			expect(manager.getEntry(appended)?.parentId).toBe(before.leaf);
			const continuedBytes = readFileSync(before.path, "utf8");
			expect(continuedBytes.startsWith(bytes)).toBe(true);
			const reopened = SessionManager.open(before.path);
			expect(reopened.getSessionId()).toBe(before.id);
			expect(reopened.getEntries().map((entry) => entry.id)).toEqual(manager.getEntries().map((entry) => entry.id));
			expect(reopened.getEntry(appended)).toEqual(manager.getEntry(appended));
			expect(reopened.getLabel(laterAssistant)).toBe("later label");
			expect(reopened.getSessionName()).toBe("original name");

			const destination = manager.createBranchedSession(firstAssistant);
			if (!destination) throw new Error("Expected successful branch path");
			expect(manager.getSessionFile()).toBe(destination);
			expect(manager.getSessionId()).not.toBe(before.id);
			expect(manager.getHeader()?.parentSession).toBe(before.path);
			expect(manager.getEntry(laterAssistant)).toBeUndefined();
			expect(manager.getLabel(laterAssistant)).toBeUndefined();
			expect(manager.getLabel(firstAssistant)).toBe("retained label");
			expect(readFileSync(before.path, "utf8")).toBe(continuedBytes);
			const retry = SessionManager.open(destination);
			expect(retry.getEntries().map((entry) => entry.id)).toEqual(manager.getEntries().map((entry) => entry.id));
			expect(retry.getLabel(firstAssistant)).toBe("retained label");
			expect(loadEntriesFromFile(destination).filter((entry) => entry.type === "session")).toHaveLength(1);
			expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		},
	);

	it("publishes a complete branch and resolved label timestamps without rewriting the source", () => {
		const { manager, firstUser, firstAssistant, laterAssistant, retainedLabel } = flushedFixture();
		const source = manager.getSessionFile();
		if (!source) throw new Error("Expected source");
		const bytes = readFileSync(source, "utf8");
		const labelTimestamp = manager.getEntry(retainedLabel)?.timestamp;
		const destination = manager.createBranchedSession(firstAssistant);
		if (!destination) throw new Error("Expected destination");
		expect(manager.getEntry(firstUser)?.parentId).toBeNull();
		expect(manager.getEntry(laterAssistant)).toBeUndefined();
		expect(manager.getSessionName()).toBeUndefined();
		expect(manager.getLabel(firstAssistant)).toBe("retained label");
		const label = manager.getEntries().find((entry) => entry.type === "label");
		expect(label).toMatchObject({
			type: "label",
			parentId: firstAssistant,
			targetId: firstAssistant,
			timestamp: labelTimestamp,
		});
		expect(manager.getLeafId()).toBe(label?.id);
		expect(manager.getHeader()?.parentSession).toBe(source);
		expect(readFileSync(source, "utf8")).toBe(bytes);
		const reopened = SessionManager.open(destination);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		expect(reopened.getTree()).toEqual(manager.getTree());
		expect(loadEntriesFromFile(destination).filter((entry) => entry.type === "session")).toHaveLength(1);
		const next = manager.appendCustomEntry("after-success");
		expect(SessionManager.open(destination).getEntry(next)).toEqual(manager.getEntry(next));
		expect(readFileSync(source, "utf8")).toBe(bytes);
	});

	it.each(["flushed", "pending"] as const)(
		"keeps no-assistant branch deferred from a %s owner and writes a single complete header later",
		(mode) => {
			const manager = SessionManager.create(tempDir, tempDir, { id: "deferred-owner" });
			const user = manager.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
			if (mode === "flushed") manager.appendMessage(assistant("outgoing reply"));
			manager.appendLabelChange(user, "kept");
			const source = manager.getSessionFile();
			if (!source) throw new Error("Expected source path");
			const bytes = mode === "flushed" ? readFileSync(source, "utf8") : undefined;
			const write = vi.spyOn(fs, "writeFileSync");
			const rename = vi.spyOn(fs, "renameSync");
			syncBuiltinESMExports();
			const destination = manager.createBranchedSession(user);
			if (!destination) throw new Error("Expected deferred destination");
			expect(write).not.toHaveBeenCalled();
			expect(rename).not.toHaveBeenCalled();
			expect(existsSync(destination)).toBe(false);
			expect(manager.getLabel(user)).toBe("kept");
			manager.appendCustomEntry("still-deferred");
			expect(existsSync(destination)).toBe(false);
			manager.appendMessage(assistant("branch reply"));
			expect(existsSync(destination)).toBe(true);
			const entries = loadEntriesFromFile(destination);
			expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
			expect(entries.length).toBe(manager.getEntries().length + 1);
			expect(SessionManager.open(destination).getEntries()).toEqual(manager.getEntries());
			const next = manager.appendCustomEntry("after-first-response");
			expect(SessionManager.open(destination).getEntry(next)).toEqual(manager.getEntry(next));
			expect(loadEntriesFromFile(destination).filter((entry) => entry.type === "session")).toHaveLength(1);
			if (bytes !== undefined) expect(readFileSync(source, "utf8")).toBe(bytes);
			else expect(existsSync(source)).toBe(false);
		},
	);

	it("keeps in-memory branches free of file I/O while re-chaining labels", () => {
		const manager = SessionManager.inMemory(tempDir, { id: "memory-owner" });
		const first = manager.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
		manager.appendLabelChange(first, "checkpoint");
		const second = manager.appendMessage(assistant("retained reply"));
		const later = manager.appendCustomEntry("discarded");
		const write = vi.spyOn(fs, "writeFileSync");
		const rename = vi.spyOn(fs, "renameSync");
		syncBuiltinESMExports();
		expect(manager.createBranchedSession(second)).toBeUndefined();
		expect(manager.getSessionId()).not.toBe("memory-owner");
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getEntry(second)?.parentId).toBe(first);
		expect(manager.getLabel(first)).toBe("checkpoint");
		expect(manager.getEntry(later)).toBeUndefined();
		const rewrite: unknown = Reflect.get(manager, "_rewriteFile");
		if (typeof rewrite !== "function") throw new Error("Missing reflective snapshot writer");
		rewrite.call(manager);
		expect(write).not.toHaveBeenCalled();
		expect(rename).not.toHaveBeenCalled();
		expect(readdirSync(tempDir)).toEqual([]);
	});

	it.each([false, true])("preserves zero-argument reflective snapshot behavior and errors (failure=%s)", (fails) => {
		const manager = SessionManager.create(tempDir, tempDir, { id: "slash-snapshot-owner" });
		manager.appendMessage({ role: "user", content: "snapshot before response", timestamp: Date.now() });
		manager.appendCustomEntry("slash-result", { exported: true });
		const before = capture(manager);
		if (!before.path) throw new Error("Expected snapshot path");
		expect(existsSync(before.path)).toBe(false);
		expect(Reflect.get(manager, "flushed")).toBe(false);
		const rewrite: unknown = Reflect.get(manager, "_rewriteFile");
		if (typeof rewrite !== "function") throw new Error("Missing reflective snapshot writer");
		const failure = new Error("snapshot rename failed");
		const rename = fails
			? vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
					throw failure;
				})
			: undefined;
		syncBuiltinESMExports();
		let observed: unknown;
		try {
			rewrite.call(manager);
		} catch (error) {
			observed = error;
		}
		expect(observed).toBe(fails ? failure : undefined);
		expect(capture(manager)).toEqual(before);
		expect(Reflect.get(manager, "flushed")).toBe(false);
		if (rename) {
			expect(rename).toHaveBeenCalledTimes(1);
			expect(existsSync(before.path)).toBe(false);
			expect(readdirSync(tempDir)).toEqual([]);
			rename.mockRestore();
			syncBuiltinESMExports();
			rewrite.call(manager);
		}
		expect(capture(manager)).toEqual(before);
		expect(Reflect.get(manager, "flushed")).toBe(false);
		const replay = SessionManager.open(before.path);
		expect(replay.getSessionId()).toBe(before.id);
		expect(replay.getEntries()).toEqual(before.entries);
		expect(loadEntriesFromFile(before.path).filter((entry) => entry.type === "session")).toHaveLength(1);
		expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it.each([false, true])("rejects an invalid leaf without changing the owner or files (persisted=%s)", (persisted) => {
		const manager = persisted ? flushedFixture().manager : SessionManager.inMemory(tempDir, { id: "memory" });
		if (!persisted) manager.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
		const before = capture(manager);
		const files = readdirSync(tempDir);
		const bytes = before.path ? readFileSync(before.path, "utf8") : undefined;
		expect(() => manager.createBranchedSession("unknown-leaf")).toThrow("Entry unknown-leaf not found");
		expect(capture(manager)).toEqual(before);
		expect(readdirSync(tempDir)).toEqual(files);
		if (before.path) expect(readFileSync(before.path, "utf8")).toBe(bytes);
	});
});
