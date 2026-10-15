import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as DiffModule from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

// A character-level diff of the whole file is quadratic in the size of the rewrite and blocks the
// event loop for seconds on a few KB. The edit path must map its replacements directly instead.
vi.mock("diff", async (importOriginal) => ({
	...(await importOriginal<typeof DiffModule>()),
	diffChars: () => {
		throw new Error("diffChars must not run on the edit path");
	},
}));

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("edit tool replacement mapping", () => {
	it("applies edits to LF and CRLF files without a character diff", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-edit-no-char-diff-"));
		directories.push(directory);
		const tool = createEditTool(directory);

		writeFileSync(join(directory, "lf.txt"), "one\ntwo\nthree\n");
		await tool.execute("lf", { path: "lf.txt", edits: [{ oldText: "two", newText: "2\n2b" }] });
		expect(readFileSync(join(directory, "lf.txt"), "utf8")).toBe("one\n2\n2b\nthree\n");

		writeFileSync(join(directory, "crlf.txt"), "one\r\ntwo  \r\nthree\r\n");
		await tool.execute("crlf", { path: "crlf.txt", edits: [{ oldText: "two\nthree", newText: "2\n3\n3b" }] });
		expect(readFileSync(join(directory, "crlf.txt"), "utf8")).toBe("one\r\n2\r\n3\r\n3b\r\n");
	});
});
