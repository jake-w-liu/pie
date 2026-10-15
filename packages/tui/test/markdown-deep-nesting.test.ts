import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function render(source: string, width: number, theme: MarkdownTheme = defaultMarkdownTheme): string[] {
	const lines = new Markdown(source, 0, 0, theme).render(width);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(stripAnsi(line))}`);
	}
	return lines;
}

describe("Markdown deep nesting", () => {
	it("renders blockquotes nested deeper than half the width in linear size", () => {
		for (const width of [20, 40, 80]) {
			for (const depth of [width / 2 + 4, width / 2 + 12]) {
				const lines = render(`${">".repeat(depth)} hi`, width);
				assert.ok(lines.length <= depth, `width ${width}, depth ${depth}: ${lines.length} lines`);
				assert.ok(
					lines.some((line) => stripAnsi(line).includes("hi")),
					`width ${width}, depth ${depth}: content missing`,
				);
			}
		}
	});

	it("renders a pytest --pdb banner pasted from a wide terminal", () => {
		const banner = `${">".repeat(94)} traceback ${">".repeat(94)}`;
		for (const width of [80, 118, 158, 198]) {
			const lines = render(`pasted log:\n\n${banner}\n`, width);
			assert.ok(lines.length < 20, `width ${width}: ${lines.length} lines`);
			assert.ok(
				lines.some((line) => stripAnsi(line).includes("traceback")),
				`width ${width}: banner text missing`,
			);
		}
	});

	it("styles nested quote lines once instead of once per level", () => {
		const [line] = render(`${">".repeat(16)} hi`, 80);
		// Restyling every nested line at every level grows the ANSI codes of a
		// line quadratically with the depth (over 5000 chars at 16 levels).
		assert.ok(line !== undefined && line.length < 1000, `line length ${line?.length}`);
	});

	it("renders alternating blockquote and list nesting in linear size", () => {
		for (const width of [20, 40]) {
			for (const pairs of [8, 16]) {
				const source = `${"> - ".repeat(pairs)}hi`;
				const lines = render(source, width);
				assert.ok(lines.length <= source.length, `width ${width}, pairs ${pairs}: ${lines.length} lines`);
			}
		}
	});

	it("lexes container nesting beyond the recursion limit as text", () => {
		for (const source of [`${">".repeat(5000)} hi`, `${"- ".repeat(6000)}hi`, `${"> - ".repeat(3000)}hi`]) {
			const lines = render(source, 200);
			assert.ok(lines.length < 200, `${JSON.stringify(source.slice(0, 8))}: ${lines.length} lines`);
			assert.ok(
				stripAnsi(lines.at(-1) ?? "")
					.trimEnd()
					.endsWith("hi"),
				"innermost text missing",
			);
		}
	});

	it("renders containers whose children produce more lines than a call can spread", () => {
		// Spreading 130k lines into push() throws RangeError.
		const lineCount = 130_000;
		const plain = (text: string) => text;
		const theme: MarkdownTheme = {
			heading: plain,
			link: plain,
			linkUrl: plain,
			code: plain,
			codeBlock: plain,
			codeBlockBorder: plain,
			quote: plain,
			quoteBorder: plain,
			hr: plain,
			listBullet: plain,
			bold: plain,
			italic: plain,
			strikethrough: plain,
			underline: plain,
			highlightCode: () => Array.from({ length: lineCount }, () => "x"),
		};
		const lines = new Markdown("> ```js\n> x\n> ```", 0, 0, theme).render(20);
		assert.strictEqual(lines.length, lineCount + 2);
	});
});
