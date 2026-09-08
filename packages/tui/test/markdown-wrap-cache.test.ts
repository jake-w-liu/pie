import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("Markdown table fallback with shared wrapping cache", () => {
	for (const width of [1, 8, 9, 80]) {
		for (const separator of ["", "\n"]) {
			it(`renders a table followed by a heading at width ${width} with ${separator.length} blank lines`, () => {
				const table = "| A | B |\n| - | - |\n| 1 | 2 |\n";
				const cached = wrapTextWithAnsi(table, width);
				const before = [...cached];
				const source = `${table}${separator}# after`;
				const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				const plain = lines.map((line) => stripTerminalSequences(line).trim()).join("");
				assert.ok(plain.includes("A") && plain.includes("B") && plain.includes("1") && plain.includes("2"));
				assert.ok(plain.endsWith("after"));
				assert.deepEqual(cached, before);
				assert.strictEqual(wrapTextWithAnsi(table, width), cached);
				assert.deepEqual(new Markdown(source, 0, 0, defaultMarkdownTheme).render(width), lines);
			});
		}
	}
});
