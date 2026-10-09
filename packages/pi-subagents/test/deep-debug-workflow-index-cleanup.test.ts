import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActiveRunIndex, readActiveRunToolCallIndex, updateActiveRunIndex } from "../src/runs/background/active-run-index.ts";
import { readRecentTerminalRunIndex } from "../src/runs/background/terminal-run-index.ts";
import * as atomic from "../src/shared/atomic-json.ts";

const writeAtomicJson = atomic.writeAtomicJson;
const removeFile = fs.rmSync;
const removeDirectory = fs.rmdirSync;
const runId = "offline-index-cleanup-run";
const toolCallId = "offline-index-cleanup-call";
const sessionId = "offline-index-cleanup-session";

function ioFault(label: string, code = "EACCES") {
	return Object.assign(new Error(`OFFLINE_INDEX_${label}`), { code });
}

describe("known-unstarted workflow strict index cleanup", () => {
	let directory: string;
	let asyncDir: string;
	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-workflow-index-cleanup-"));
		asyncDir = join(directory, runId);
		const now = Date.now();
		writeAtomicJson(join(asyncDir, "status.json"), { runId, toolCallId, sessionId, state: "failed", mode: "workflow", startedAt: now, lastUpdate: now, endedAt: now, steps: [] });
		updateActiveRunIndex(asyncDir, "running", toolCallId);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it.each(["EACCES", "ENOSPC"])("exposes terminal-index %s in strict cleanup without changing ordinary best-effort behavior", (code) => {
		vi.spyOn(atomic, "writeAtomicJson").mockImplementation((filePath, payload) => {
			if (filePath.includes("/.terminal-runs/")) throw ioFault(`TERMINAL_${code}`, code);
			writeAtomicJson(filePath, payload);
		});
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId)).not.toThrow();
		expect(console.error).toHaveBeenCalled();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).toThrow(`OFFLINE_INDEX_TERMINAL_${code}`);
		expect(readActiveRunIndex(directory) ?? []).toEqual([]);
		expect(readActiveRunToolCallIndex(directory, toolCallId)).toEqual([]);
	});

	it("retains the existing capacity-retry policy for ordinary terminal indexing", () => {
		vi.spyOn(atomic, "writeAtomicJson").mockImplementation((filePath, payload) => {
			if (filePath.includes("/.terminal-runs/")) throw ioFault("CAPACITY", "ENOSPC");
			writeAtomicJson(filePath, payload);
		});
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { retryCapacityErrors: true })).toThrow("OFFLINE_INDEX_CAPACITY");
	});

	it.each(["enumeration", "removal"])("makes alias %s errors strict only while attempting terminal publication", (phase) => {
		if (phase === "enumeration") vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => { throw ioFault("ALIAS_ENUMERATION"); });
		else vi.spyOn(fs, "rmSync").mockImplementation((filePath, options) => {
			if (String(filePath).includes("/tool-calls/")) throw ioFault("ALIAS_REMOVAL");
			removeFile(filePath, options);
		});
		syncBuiltinESMExports();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).toThrow(`OFFLINE_INDEX_ALIAS_${phase.toUpperCase()}`);
		expect(readRecentTerminalRunIndex(directory, { sessionId })).toEqual([runId]);
		if (phase === "enumeration") vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => { throw ioFault("ORDINARY_ALIAS_ENUMERATION"); });
		syncBuiltinESMExports();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId)).not.toThrow();
	});

	it("attempts independent authoritative, alias and terminal cleanup and aggregates their real errors", () => {
		const removals: string[] = [];
		vi.spyOn(fs, "rmSync").mockImplementation((filePath, options) => {
			const text = String(filePath);
			removals.push(text);
			if (text.endsWith(`/${runId}`) && text.includes("/.active-runs/")) throw ioFault(text.includes("/tool-calls/") ? "ALIAS" : "AUTHORITATIVE");
			removeFile(filePath, options);
		});
		const terminal = vi.spyOn(atomic, "writeAtomicJson").mockImplementation((filePath, payload) => {
			if (filePath.includes("/.terminal-runs/")) throw ioFault("TERMINAL");
			writeAtomicJson(filePath, payload);
		});
		syncBuiltinESMExports();
		let failure: unknown;
		try { updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true }); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(AggregateError);
		expect(String(failure)).toContain("OFFLINE_INDEX_AUTHORITATIVE");
		expect(String(failure)).toContain("OFFLINE_INDEX_ALIAS");
		expect(String(failure)).toContain("OFFLINE_INDEX_TERMINAL");
		expect(removals.some((filePath) => filePath.includes("/tool-calls/"))).toBe(true);
		expect(terminal.mock.calls.some(([filePath]) => filePath.includes("/.terminal-runs/"))).toBe(true);
	});

	it("does not abandon a later alias after the first owned alias fails", () => {
		updateActiveRunIndex(asyncDir, "running", `${toolCallId}-second`);
		vi.spyOn(fs, "rmSync").mockImplementation((filePath, options) => {
			if (String(filePath).includes("/tool-calls/") && String(filePath).includes(toolCallId) && !String(filePath).includes(`${toolCallId}-second`)) throw ioFault("FIRST_ALIAS");
			removeFile(filePath, options);
		});
		syncBuiltinESMExports();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).toThrow("OFFLINE_INDEX_FIRST_ALIAS");
		expect(readActiveRunToolCallIndex(directory, `${toolCallId}-second`)).toEqual([]);
		expect(readRecentTerminalRunIndex(directory, { sessionId })).toEqual([runId]);
	});

	it.each(["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"])("accepts expected ancestor-pruning %s without false corruption", (code) => {
		vi.spyOn(fs, "rmdirSync").mockImplementationOnce(() => { throw ioFault("EXPECTED_PRUNING", code); });
		syncBuiltinESMExports();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).not.toThrow();
		expect(readActiveRunToolCallIndex(directory, toolCallId)).toEqual([]);
		expect(readRecentTerminalRunIndex(directory, { sessionId })).toEqual([runId]);
	});

	it("reports unexpected ancestor-pruning I/O and still publishes terminal truth", () => {
		vi.spyOn(fs, "rmdirSync").mockImplementation((filePath) => {
			if (String(filePath).includes("/tool-calls/")) throw ioFault("PRUNING");
			removeDirectory(filePath);
		});
		syncBuiltinESMExports();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).toThrow("OFFLINE_INDEX_PRUNING");
		expect(readActiveRunToolCallIndex(directory, toolCallId)).toEqual([]);
		expect(readRecentTerminalRunIndex(directory, { sessionId })).toEqual([runId]);
	});

	it.each(["missing index root", "non-directory index root"])("treats %s as absent during strict cleanup", (phase) => {
		const indexRoot = join(directory, ".active-runs");
		fs.rmSync(indexRoot, { recursive: true, force: true });
		if (phase === "non-directory index root") fs.writeFileSync(indexRoot, "not a directory");
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).not.toThrow();
		expect(readActiveRunToolCallIndex(directory, toolCallId)).toEqual([]);
		expect(readRecentTerminalRunIndex(directory, { sessionId })).toEqual([runId]);
	});

	it.each(["missing", "different state"])("does not claim terminal publication with %s authoritative status", (phase) => {
		if (phase === "missing") fs.rmSync(join(asyncDir, "status.json"));
		else writeAtomicJson(join(asyncDir, "status.json"), { runId, toolCallId, sessionId, state: "running" });
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId)).not.toThrow();
		expect(() => updateActiveRunIndex(asyncDir, "failed", toolCallId, { strictCleanup: true })).toThrow("Cannot publish async terminal-run index");
		expect(readRecentTerminalRunIndex(directory, { sessionId })).toEqual([]);
	});
});
