import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWorkflowParserEntry, validateWorkflowScript } from "../src/workflows/scripted-workflow.ts";

const testRequire = createRequire(import.meta.url);
const repoRoot = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));

type AcornParser = { parse: (source: string, options: Record<string, unknown>) => { type: string } };

function loadParser(entry: string): AcornParser {
	const parser = testRequire(entry) as AcornParser;
	expect(typeof parser.parse).toBe("function");
	return parser;
}

function brokenRequire(): NodeRequire {
	const resolve = (): string => {
		throw Object.assign(new Error("Cannot find module 'acorn'"), { code: "MODULE_NOT_FOUND" });
	};
	return { resolve } as unknown as NodeRequire;
}

describe("workflow parser resolution", () => {
	it("resolves a requirable parser from a healthy install", () => {
		const entry = resolveWorkflowParserEntry();
		const parser = loadParser(entry);
		expect(parser.parse("1 + 1", { ecmaVersion: "latest" }).type).toBe("Program");
	});

	it("falls back to a working tmp copy when disk resolution fails (stale release)", () => {
		const healthy = resolveWorkflowParserEntry();
		const expectedSource = readFileSync(healthy, "utf8");
		const emptyCwd = mkdtempSync(join(tmpdir(), "pie-parser-test-"));
		try {
			expect(() => createRequire(join(emptyCwd, "package.json")).resolve("acorn")).toThrow();
			const fallback = resolveWorkflowParserEntry(brokenRequire(), emptyCwd);
			expect(dirname(fallback)).toBe(join(tmpdir(), "pie-workflow-parser"));
			expect(readFileSync(fallback, "utf8")).toBe(expectedSource);
			const parser = loadParser(fallback);
			expect(parser.parse("1 + 1", { ecmaVersion: "latest" }).type).toBe("Program");
		} finally {
			rmSync(emptyCwd, { recursive: true, force: true });
		}
	});

	it("keeps the invocation-cwd fallback when package resolution fails", () => {
		const entry = resolveWorkflowParserEntry(brokenRequire(), repoRoot);
		expect(entry.startsWith(repoRoot)).toBe(true);
		loadParser(entry);
	});

	it("throws the original error when disk and tmp fallbacks both fail", () => {
		resolveWorkflowParserEntry();
		const emptyCwd = mkdtempSync(join(tmpdir(), "pie-parser-test-"));
		const blocker = join(emptyCwd, "blocker");
		writeFileSync(blocker, "not a directory");
		const previousTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = blocker;
		try {
			expect(() => createRequire(join(emptyCwd, "package.json")).resolve("acorn")).toThrow();
			expect(() => resolveWorkflowParserEntry(brokenRequire(), emptyCwd)).toThrow(/Cannot find module 'acorn'/);
		} finally {
			if (previousTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpdir;
			rmSync(emptyCwd, { recursive: true, force: true });
		}
	});

	it("refuses to write the tmp copy through a planted symlink", () => {
		// The fallback path is fixed and predictable, so a symlink there must not turn
		// it into an overwrite of whatever the link points at.
		resolveWorkflowParserEntry();
		const emptyCwd = mkdtempSync(join(tmpdir(), "pie-parser-test-"));
		const parserDirectory = join(tmpdir(), "pie-workflow-parser");
		const victim = join(emptyCwd, "victim.txt");
		writeFileSync(victim, "ORIGINAL");
		try {
			rmSync(parserDirectory, { recursive: true, force: true });
			mkdirSync(parserDirectory, { recursive: true });
			symlinkSync(victim, join(parserDirectory, "acorn.js"));
			expect(() => resolveWorkflowParserEntry(brokenRequire(), emptyCwd)).toThrow(/Cannot find module 'acorn'/);
			expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
		} finally {
			rmSync(parserDirectory, { recursive: true, force: true });
			rmSync(emptyCwd, { recursive: true, force: true });
		}
	});

	it("materializes the tmp copy readable only by this user", () => {
		resolveWorkflowParserEntry();
		const emptyCwd = mkdtempSync(join(tmpdir(), "pie-parser-test-"));
		const parserDirectory = join(tmpdir(), "pie-workflow-parser");
		try {
			rmSync(parserDirectory, { recursive: true, force: true });
			const fallback = resolveWorkflowParserEntry(brokenRequire(), emptyCwd);
			expect(statSync(fallback).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(fallback)).mode & 0o777).toBe(0o700);
			loadParser(fallback);
		} finally {
			rmSync(parserDirectory, { recursive: true, force: true });
			rmSync(emptyCwd, { recursive: true, force: true });
		}
	});

	it("validates scripts independently of parser resolution", () => {
		expect(validateWorkflowScript("return runs.run('a', { agent: 'worker', task: 'x' });").ok).toBe(true);
		expect(validateWorkflowScript("const = broken (").ok).toBe(false);
		expect(validateWorkflowScript("").ok).toBe(false);
	});
});
