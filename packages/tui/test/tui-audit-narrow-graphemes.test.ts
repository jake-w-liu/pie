import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const graphemes = ["字", "\u{1f600}", "\u{1f469}\u200d\u{1f4bb}", "e\u0301", "กำ"];
const plain = (lines: string[]) => lines.map(stripTerminalSequences);

describe("styled indentation at narrow widths", () => {
	for (const [open, close] of [
		["\x1b[31m", "\x1b[0m"],
		["\x1b[41;4m", "\x1b[24;49m"],
		["\x1b]8;;https://example.test/a b\x07", "\x1b]8;;\x07"],
	]) {
		for (const whitespace of ["      ", "\t\t", "\u3000\u3000"]) {
			for (const width of [1, 2, 3]) {
				it(`bounds ${JSON.stringify(open + whitespace + close)} at ${width} without dropping later text`, () => {
					for (const suffix of ["", "word"]) {
						// ASCII space marks a word boundary; tabs/wide spaces inside a word
						// otherwise follow the documented indivisible-grapheme policy.
						const source = `${open}${whitespace}${close}${suffix ? ` ${suffix}` : ""}`;
						const wrapped = wrapTextWithAnsi(source, width);
						assert.ok(
							wrapped.every((line) => visibleWidth(line) <= width),
							JSON.stringify(wrapped),
						);
						assert.equal(plain(wrapped).join("").replace(/\s/g, ""), suffix);
						assert.ok(new Text(source, 0, 0).render(width).every((line) => visibleWidth(line) <= width));
						assert.deepEqual(wrapTextWithAnsi(source, 40), [source]);
						assert.ok(wrapped.join("").includes(close), "retain the original closing sequence");
					}
				});
			}
		}
	}
	it("preserves background continuation across a clipped blank line", () => {
		const lines = wrapTextWithAnsi("\x1b[41m     \nword\x1b[0m", 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= 2));
		assert.ok(!lines[0].includes("\x1b[0m"));
		assert.ok(lines.slice(1).every((line) => line.includes("\x1b[41m")));
	});
});

describe("indivisible graphemes at narrow widths", () => {
	for (const grapheme of graphemes) {
		for (const width of [1, 2]) {
			const expected = visibleWidth(grapheme) > width ? "\ufffd" : grapheme;
			it(`wraps ${JSON.stringify(grapheme)} at ${width} without empty or over-wide rows`, () => {
				assert.deepEqual(wrapTextWithAnsi(grapheme, width), [expected]);
				assert.deepEqual(plain(wrapTextWithAnsi(`\x1b[31;4m${grapheme}\x1b[0m`, width)), [expected]);
				const link = `\x1b]8;;https://example.test\x07${grapheme}${grapheme}\x1b]8;;\x07`;
				const wrapped = wrapTextWithAnsi(link, width);
				assert.ok(wrapped.every((line) => visibleWidth(line) <= width && visibleWidth(line) > 0));
				assert.equal(plain(wrapped).join(""), expected.repeat(2));
				assert.ok(
					wrapped.every(
						(line) => line.includes("\x1b]8;;https://example.test\x07") && line.endsWith("\x1b]8;;\x07"),
					),
				);
			});
			it(`keeps Text/Markdown sources for wider rerender (${JSON.stringify(grapheme)}, ${width})`, () => {
				for (const component of [new Text(grapheme, 0, 0), new Markdown(grapheme, 0, 0, defaultMarkdownTheme)]) {
					const rendered = component.render(width);
					assert.equal(rendered.length, 1);
					assert.ok(rendered.every((line) => visibleWidth(line) <= width));
					assert.equal(plain(rendered).join("").trimEnd(), expected);
					assert.equal(plain(component.render(20)).join("").trimEnd(), grapheme);
				}
			});
		}
		it(`preserves editor chunks, cursor and submission for ${JSON.stringify(grapheme)}`, () => {
			const source = `a${grapheme}b`;
			const chunks = wordWrapLine(source, 1);
			assert.equal(chunks.map((chunk) => chunk.text).join(""), source);
			for (const chunk of chunks) {
				assert.ok(chunk.endIndex > chunk.startIndex);
				assert.equal(chunk.text, source.slice(chunk.startIndex, chunk.endIndex));
			}
			const tui = new TuiMainScreen(new VirtualTerminal());
			const editor = new Editor(tui, defaultEditorTheme);
			editor.focused = true;
			editor.setText(grapheme);
			for (const width of [1, 2]) {
				const rendered = editor.render(width);
				assert.ok(
					rendered.every((line) => visibleWidth(line) <= width),
					JSON.stringify(rendered),
				);
				assert.equal(rendered.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
				assert.equal(editor.getText(), grapheme);
				assert.equal(editor.getCursor().col, grapheme.length);
				// Clicking the first cell selects the entire original grapheme, not the placeholder.
				editor.handleMousePress(0, 1);
				assert.equal(editor.getCursor().col, 0);
				assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
				editor.handleInput("\x1b[C");
				assert.equal(editor.getCursor().col, grapheme.length);
				if (width === 2) {
					// Column one is after the narrow display cell, even when the raw
					// source grapheme occupies two or more cells at normal widths.
					editor.handleMousePress(1, 1);
					assert.equal(editor.getCursor().col, grapheme.length);
				}
			}
			assert.ok(plain(editor.render(20)).some((line) => line.includes(grapheme)));
			let submitted: string | undefined;
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.handleInput("\r");
			assert.equal(submitted, grapheme);
			tui.stop();
		});
	}

	it("renders a collapsed paste in a narrow editor without changing its expansion", () => {
		const tui = new TuiMainScreen(new VirtualTerminal());
		const editor = new Editor(tui, defaultEditorTheme);
		const source = "字".repeat(1100);
		editor.handleInput(`\x1b[200~${source}\x1b[201~`);
		for (const width of [1, 2, 10, 80]) {
			assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
			assert.equal(editor.getExpandedText(), source);
		}
		tui.stop();
	});
});
