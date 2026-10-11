import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, normalizeForFuzzyMatch } from "../src/core/tools/edit-diff.ts";

function apply(content: string, oldText: string, newText: string): string {
	const { newContent } = applyEditsToNormalizedContent(content, [{ oldText, newText }], "test.ts");
	return newContent;
}

describe("edit-diff fuzzy matching", () => {
	it("matches exact text", () => {
		const out = apply("const x = 1;\n", "const x = 1;", "const x = 42;");
		expect(out).toContain("const x = 42;");
	});

	it("tolerates trailing whitespace differences", () => {
		const out = apply("const x = 1;  \n", "const x = 1;", "const x = 42;");
		expect(out).toContain("const x = 42;");
	});

	it("tolerates leading indentation differences (tab vs spaces)", () => {
		// file uses a tab; oldText uses 4 spaces
		const out = apply("if (a) {\n\tconst x = 1;\n}\n", "    const x = 1;", "    const x = 99;");
		expect(out).toContain("const x = 99;");
	});

	it("tolerates leading indentation differences (spaces vs tab)", () => {
		const out = apply("if (a) {\n    const x = 1;\n}\n", "\tconst x = 1;", "\tconst x = 7;");
		expect(out).toContain("const x = 7;");
	});

	it("rejects ambiguous matches", () => {
		expect(() => apply("const x = 1;\nconst x = 1;\n", "const x = 1;", "changed")).toThrow(/must be unique/i);
		expect(() => apply("end\nend\nend\n", "end\nend", "changed")).toThrow(/must be unique/i);
	});

	it("preserves matched indentation when fuzzy matching trailing whitespace", () => {
		expect(apply("def f():\n    x = 1   \n", " x = 1\n", " x = 2\n")).toBe("def f():\n    x = 2\n");
	});

	it("reports whitespace-only old text as not found instead of editing at offset 0", () => {
		expect(() => apply("hello world\n", "\u00a0", "X")).toThrow(/not found/i);
		expect(() => apply("hello world\n", "\t\t", "X")).toThrow(/not found/i);
	});

	it("rejects a pattern that overlaps itself", () => {
		expect(() => apply("aaa", "aa", "b")).toThrow(/must be unique/i);
	});

	it("normalizeForFuzzyMatch collapses leading indentation and trailing whitespace", () => {
		expect(normalizeForFuzzyMatch("\tfoo   \n    bar")).toBe(" foo\n bar");
	});
});
