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

	it("keeps the untouched start of a line when a mid-line fuzzy match adds lines", () => {
		const content = "def f(x, y):\n    if x:\n        total = compute(x)  \n        return total\n    return 0\n";
		const out = apply(
			content,
			"compute(x)\n        return total",
			"compute(x, y)\n        log(total)\n        return total",
		);
		expect(out).toBe(
			"def f(x, y):\n    if x:\n        total = compute(x, y)\n        log(total)\n        return total\n    return 0\n",
		);
	});

	it("does not normalize characters outside a fuzzy match", () => {
		const content = "msg = \u201cHello\u201d  # \uff08\u6ce8\u610f\uff09 \u00bd done \u2014 ok\nnext\n";
		expect(apply(content, 'msg = "Hello"', 'msg = "Hi"')).toBe(
			'msg = "Hi"  # \uff08\u6ce8\u610f\uff09 \u00bd done \u2014 ok\nnext\n',
		);
	});

	it("does not match part of a character's normalized form", () => {
		// "½" normalizes to "1⁄2"; replacing only "2" would also rewrite the rest of "½".
		expect(() => apply("x = \u00bd;\n", "2;", "3;")).toThrow(/not found/i);
	});

	it("applies an intended re-indent when the old text used the file's indentation", () => {
		// Trailing spaces after a() force the fuzzy path; the indentation itself matched.
		const content = "def f(x):\n    if x:\n        a()  \n        b()\n    return 1\n";
		expect(apply(content, "        a()\n        b()", "        a()\n    b()")).toBe(
			"def f(x):\n    if x:\n        a()\n    b()\n    return 1\n",
		);
	});

	it("translates the old text's indentation style to the file's, including added lines", () => {
		const content = "function f() {\n\tif (a) {\n\t\tx();\n\t}\n}\n";
		const out = apply(
			content,
			"    if (a) {\n        x();\n    }",
			"    if (a) {\n        x();\n        y();\n    }",
		);
		expect(out).toBe("function f() {\n\tif (a) {\n\t\tx();\n\t\ty();\n\t}\n}\n");
	});

	it("converts deeper new lines to the file's indentation step", () => {
		// One matched level: four spaces in oldText for the file's tab.
		expect(apply("function f() {\n\ty();\n}\n", "    y();", "    if (c) {\n        y();\n    }")).toBe(
			"function f() {\n\tif (c) {\n\t\ty();\n\t}\n}\n",
		);
		// Two matched levels give the step even when oldText is offset from the file.
		expect(
			apply(
				"\t\tif (x) {\n\t\t\ty();\n\t\t}\n",
				"    if (x) {\n        y();\n    }",
				"    if (x) {\n        if (z) {\n            y();\n        }\n    }",
			),
		).toBe("\t\tif (x) {\n\t\t\tif (z) {\n\t\t\t\ty();\n\t\t\t}\n\t\t}\n");
		// With one level and the same character, a different step cannot be told from an offset.
		expect(
			apply("class A:\n    def f(self):\n        x = \u201ca\u201d\n", '    x = "a"', '    if y:\n        x = "a"'),
		).toBe('class A:\n    def f(self):\n        if y:\n            x = "a"\n');
	});

	it("edits beside a line whose compatibility jamo compose only when normalized together", () => {
		// NFKC turns "\u314e\u314f" into "\ud558" as a pair, not one jamo at a time.
		const content = 'const jamo = "\u314e\u314f";\nfunction greet() {\n\treturn \u201chello\u201d;\n}\n';
		expect(apply(content, 'return "hello";', 'return "bye";')).toBe(
			'const jamo = "\u314e\u314f";\nfunction greet() {\n\treturn "bye";\n}\n',
		);
		// A fuzzy match covers such a line entirely or not at all.
		const padded = 'const jamo = "\u314e\u314f";  \nnext\n';
		expect(apply(padded, 'const jamo = "\u314e\u314f";\nnext', 'const jamo = "x";\nnext')).toBe(
			'const jamo = "x";\nnext\n',
		);
		expect(() => apply(padded, '"\u314e\u314f";\nnext', '"x";\nnext')).toThrow(/not found/i);
	});

	it("accepts an exact match that is unique even when fuzzy normalization finds more", () => {
		expect(apply("    return null;\n        return null;\n", "        return null;", "        return 0;")).toBe(
			"    return null;\n        return 0;\n",
		);
	});

	it("edits a file whose last line is whitespace-only without a trailing newline", () => {
		const oldText = "const a = 1;\nconst b = 2;";
		const newText = "const a = 10;\nconst b = 2;";
		expect(apply("const a = 1;  \nconst b = 2;\n    ", oldText, newText)).toBe("const a = 10;\nconst b = 2;\n    ");
		expect(apply("const a = 1;  \nconst b = 2;\n\u00a0", oldText, newText)).toBe(
			"const a = 10;\nconst b = 2;\n\u00a0",
		);
	});
});
