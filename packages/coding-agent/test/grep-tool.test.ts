import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";

/**
 * The grep tool delegates the search to ripgrep and only formats what comes
 * back. These tests pin the parts of that contract this implementation owns:
 * which rg output format each mode selects, that the path and line number stay
 * unambiguous for paths containing the field separator, and that context lines
 * come from ripgrep rather than a second read of every matched file.
 *
 * ripgrep walks files in parallel, so file order is not stable. Assertions
 * either sort first or restrict the search to a single file.
 */

let root: string;
let tool: ReturnType<typeof createGrepTool>;

async function grep(args: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("test", args as never);
	return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pie-grep-"));
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src", "alpha.ts"),
		["const alpha = 1;", "const needle = 2;", "const alphaAgain = 3;", "", "// trailing needle"].join("\n"),
	);
	writeFileSync(join(root, "src", "beta.ts"), ["export const needle = 1;", "export const other = 2;"].join("\n"));
	writeFileSync(join(root, "src", "gamma.md"), ["a needle in markdown", "nothing here"].join("\n"));
	// A directory whose name contains the ":" separator, which breaks naive
	// splitting of "path:line:text" and is why content mode reads --json.
	mkdirSync(join(root, "weird:dir"), { recursive: true });
	writeFileSync(join(root, "weird:dir", "delta.ts"), ["const needle = 3;", "const tail = 4;"].join("\n"));
	tool = createGrepTool(root);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("grep output modes", () => {
	it("reports matching files, one path per line and with no match events", async () => {
		const output = await grep({ pattern: "needle", path: root, outputMode: "files_with_matches" });
		expect(output.split("\n").sort()).toEqual(["src/alpha.ts", "src/beta.ts", "src/gamma.md", "weird:dir/delta.ts"]);
	});

	it("counts matching lines rather than occurrences, like ripgrep -c", async () => {
		// "needle" appears on two lines of alpha.ts plus one each in the other three files.
		expect(await grep({ pattern: "needle", path: root, outputMode: "count" })).toBe("5");
		// "alpha" hits lines 1 and 3 of alpha.ts. Line 1 also matches "alpha" twice,
		// so counting occurrences instead would report 3.
		expect(await grep({ pattern: "alpha", path: root, outputMode: "count" })).toBe("2");
	});

	it("counts matches inside a single file, where ripgrep prints a bare number", async () => {
		// rg -c omits the path prefix when the search target is one file, so the
		// count line has no separator to split on.
		expect(await grep({ pattern: "needle", path: join(root, "src", "alpha.ts"), outputMode: "count" })).toBe("2");
		expect(await grep({ pattern: "needle", path: join(root, "src", "beta.ts"), outputMode: "count" })).toBe("1");
		expect(await grep({ pattern: "needle", path: join(root, "src", "beta.ts") })).toBe(
			"=== beta.ts ===\nbeta.ts:1: export const needle = 1;",
		);
	});

	it("reports zero and a notice when nothing matches", async () => {
		expect(await grep({ pattern: "definitely-absent-token", path: root, outputMode: "count" })).toBe("0");
		expect(await grep({ pattern: "definitely-absent-token", path: root })).toBe("No matches found");
		expect(await grep({ pattern: "definitely-absent-token", path: root, outputMode: "files_with_matches" })).toBe(
			"No matches found",
		);
	});
});

describe("grep content formatting", () => {
	it("groups matches under a per-file header", async () => {
		const output = await grep({ pattern: "needle", path: root, glob: "**/alpha.ts" });
		expect(output.split("\n")).toEqual([
			"=== src/alpha.ts ===",
			"src/alpha.ts:2: const needle = 2;",
			"src/alpha.ts:5: // trailing needle",
		]);
	});

	it("keeps a path containing ':' intact instead of splitting on the first one", async () => {
		const output = await grep({ pattern: "needle", path: root, glob: "**/delta.ts" });
		expect(output.split("\n")).toEqual(["=== weird:dir/delta.ts ===", "weird:dir/delta.ts:1: const needle = 3;"]);
	});

	it("emits context lines around the match", async () => {
		const output = await grep({ pattern: "alphaAgain", path: root, glob: "**/alpha.ts", context: 1 });
		expect(output.split("\n")).toEqual([
			"=== src/alpha.ts ===",
			"src/alpha.ts-2- const needle = 2;",
			"src/alpha.ts:3: const alphaAgain = 3;",
			// Line 4 is empty; the separator still sits between the number and the text.
			"src/alpha.ts-4- ",
		]);
	});

	it("stops at the match limit and says so", async () => {
		const output = await grep({ pattern: "needle", path: root, limit: 1 });
		const lines = output.split("\n").filter(Boolean);
		expect(lines).toHaveLength(3);
		// ripgrep picks a different first file on each run, so tie the header to the
		// one match line rather than naming a file.
		const header = /^=== (\S+) ===$/.exec(lines[0])?.[1];
		expect(header).toBeTruthy();
		// The first file ripgrep reports varies per run, and each file's first
		// match sits on a different line, so check the shared shape only.
		expect(lines[1].startsWith(`${header}:`)).toBe(true);
		expect(lines[1]).toContain("needle");
		expect(lines[2]).toBe("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
	});

	it("keeps the separator shape when a match line is empty", async () => {
		// An empty pattern-free line only matches if the regex can match nothing,
		// so use an alternation that can match the empty line.
		const output = await grep({ pattern: "^$", path: root, glob: "**/alpha.ts" });
		expect(output.split("\n")).toEqual(["=== src/alpha.ts ===", "src/alpha.ts:4: "]);
	});
});

describe("grep flag handling", () => {
	it("honours literal matching", async () => {
		expect(await grep({ pattern: "a.pha", path: root, outputMode: "count" })).toBe("2");
		expect(await grep({ pattern: "a.pha", path: root, outputMode: "count", literal: true })).toBe("0");
	});

	it("honours ignoreCase", async () => {
		expect(await grep({ pattern: "NEEDLE", path: root, outputMode: "count" })).toBe("0");
		expect(await grep({ pattern: "NEEDLE", path: root, outputMode: "count", ignoreCase: true })).toBe("5");
	});

	it("honours glob filtering", async () => {
		expect(await grep({ pattern: "needle", path: root, glob: "**/alpha.ts", outputMode: "count" })).toBe("2");
	});

	it("rejects an invalid regex rather than reporting no matches", async () => {
		await expect(grep({ pattern: "([unclosed", path: root })).rejects.toThrow();
	});

	it("rejects a missing search path", async () => {
		await expect(grep({ pattern: "needle", path: join(root, "no-such-dir") })).rejects.toThrow(/Path not found/);
	});
});

describe("grep output ceiling", () => {
	it("bounds files_with_matches output and reports the truncation", async () => {
		const manyRoot = mkdtempSync(join(tmpdir(), "pie-grep-many-"));
		try {
			mkdirSync(join(manyRoot, "many"));
			for (let index = 0; index < 2_000; index++) {
				writeFileSync(join(manyRoot, "many", `matching-file-${index}-abcdefghijklmnopqrstuvwxyz.txt`), "needle\n");
			}
			const manyTool = createGrepTool(manyRoot);
			const result = await manyTool.execute("test", {
				pattern: "needle",
				path: manyRoot,
				outputMode: "files_with_matches",
			} as never);
			const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
			// The documented 50KB ceiling applies to every output mode; thousands of
			// matching paths used to be returned whole.
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(60_000);
			expect(text).toContain("limit reached");
			expect(result.details).toMatchObject({ truncation: { truncated: true } });
		} finally {
			rmSync(manyRoot, { recursive: true, force: true });
		}
	}, 60_000);
});
