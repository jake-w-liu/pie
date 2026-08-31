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
	});

	it("normalizeForFuzzyMatch collapses leading indentation and trailing whitespace", () => {
		expect(normalizeForFuzzyMatch("\tfoo   \n    bar")).toBe(" foo\n bar");
	});
});
