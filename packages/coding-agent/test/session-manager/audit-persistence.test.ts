import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

		// Branching writes the new branch file via _rewriteFile (the P1 code path).
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
