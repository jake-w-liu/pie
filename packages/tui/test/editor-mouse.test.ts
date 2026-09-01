import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

describe("Editor mouse click-to-position", () => {
	it("positions the cursor on a single-line editor with no padding", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello");
		// render(width) returns [topBorder, content, bottomBorder], contentWidth = width - 2*paddingX.
		// paddingX = 0 by default -> content column boxX maps directly to a char column.
		editor.render(80);

		// Box row 1 is the first content row (box row 0 is the top border).
		// Clicking on column 2 ("l") positions the cursor at index 2.
		assert.strictEqual(editor.positionCursorAtScreen(2, 1, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("clamps clicks past the end of the text to the line end", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hi");
		editor.render(80);

		assert.strictEqual(editor.positionCursorAtScreen(60, 1, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("clamps clicks in the padding (left of the text) to column 0", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello");
		// paddingX 4 -> content begins at boxX 4.
		editor.setPaddingX(4);
		editor.render(80);

		// Click on the padding (boxX 0) clamps to column 0.
		assert.strictEqual(editor.positionCursorAtScreen(0, 1, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		// Click on boxX 6 (content column 2) positions at index 2.
		assert.strictEqual(editor.positionCursorAtScreen(6, 1, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("maps clicks across logical lines with multi-line text", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("first\nsecond\nthird");
		editor.render(80);

		// Row 1 -> logical line 0, row 2 -> logical line 1, row 3 -> logical line 2.
		assert.strictEqual(editor.positionCursorAtScreen(3, 2, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 3 });
		assert.strictEqual(editor.positionCursorAtScreen(1, 3, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 1 });
	});

	it("returns false for clicks on the top/bottom borders", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello");
		editor.render(80);

		// Row 0 is the top border, row (visibleCount+1) is the bottom border.
		assert.strictEqual(editor.positionCursorAtScreen(5, 0, 80), false);
		assert.strictEqual(editor.positionCursorAtScreen(5, 2, 80), false);
	});

	it("maps clicks within wrapped lines to the correct logical line and column", () => {
		const editor = new Editor(createTestTUI(10), defaultEditorTheme);
		editor.setText("abcdefghijklmnop");
		editor.render(10);

		// With paddingX 0 the editor reserves a column for the cursor, so layoutWidth is
		// width - 1 = 9. The 16-char single line wraps into two layout rows:
		//   box row 1 = "abcdefghi" (chars 0-8, startIndex 0)
		//   box row 2 = "jklmnop"   (chars 9-15, startIndex 9)
		// Both belong to logical line 0.
		// Clicking box row 1, column 1 -> logical line 0, col 1.
		assert.strictEqual(editor.positionCursorAtScreen(1, 1, 10), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		// Clicking box row 2, column 0 -> the start of the wrapped segment, col 9.
		assert.strictEqual(editor.positionCursorAtScreen(0, 2, 10), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });
		// Clicking box row 2, column 5 -> col 14.
		assert.strictEqual(editor.positionCursorAtScreen(5, 2, 10), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 14 });
		// Clicking past the end of the wrapped segment clamps to the logical end (16).
		assert.strictEqual(editor.positionCursorAtScreen(9, 2, 10), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 16 });
	});

	it("positions across wide (double-width) graphemes by snapping to the grapheme start", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		// "a" (1) + "✅" (2) + "b" (1) = 4 columns.
		editor.setText("a✅b");
		editor.render(80);

		// Clicking at column 2 (second half of the wide emoji) snaps to its start (col 1).
		assert.strictEqual(editor.positionCursorAtScreen(2, 1, 80), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
	});

	it("selects a range by begin + extend and returns the text", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello world");
		editor.render(80);

		// Begin selection at box (x=0,y=1) -> logical col 0; extend to box (x=5,y=1) -> col 5.
		assert.strictEqual(editor.beginMouseSelection(0, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(5, 1, 80), true);
		assert.strictEqual(editor.endMouseSelection(), "hello");
		assert.strictEqual(editor.getSelectedText(), "hello");
	});

	it("normalizes a reverse drag (focus before anchor) into the correct range", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello world");
		editor.render(80);

		// Begin at col 5, drag back to col 1 -> selection is chars 1..5 = "ello".
		assert.strictEqual(editor.beginMouseSelection(5, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(1, 1, 80), true);
		assert.strictEqual(editor.getSelectedText(), "ello");
	});

	it("selects across multiple logical lines", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("first\nsecond\nthird");
		editor.render(80);

		// Begin on line 0 col 2, extend to line 2 col 2.
		assert.strictEqual(editor.beginMouseSelection(2, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(2, 3, 80), true);
		assert.strictEqual(editor.getSelectedText(), "rst\nsecond\nth");
	});

	it("returns null for a collapsed (zero-length) selection", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello");
		editor.render(80);

		assert.strictEqual(editor.beginMouseSelection(2, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(2, 1, 80), true);
		assert.strictEqual(editor.getSelectedText(), null);
		assert.strictEqual(editor.endMouseSelection(), null);
	});

	it("selects across a wrapped logical line", () => {
		const editor = new Editor(createTestTUI(10), defaultEditorTheme);
		editor.setText("abcdefghijklmnop");
		editor.render(10);

		// Layout width 9: box row 1 = cols 0-8, box row 2 = cols 9-15.
		// Select from box (1,1) col 1 to box (3,2) col 12 -> "bcdefghijkl".
		assert.strictEqual(editor.beginMouseSelection(1, 1, 10), true);
		assert.strictEqual(editor.extendMouseSelection(3, 2, 10), true);
		assert.strictEqual(editor.getSelectedText(), "bcdefghijkl");
	});

	it("clears the selection highlight via clearMouseSelection", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello world");
		editor.render(80);

		assert.strictEqual(editor.beginMouseSelection(0, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(5, 1, 80), true);
		assert.strictEqual(editor.getSelectedText(), "hello");
		editor.clearMouseSelection();
		assert.strictEqual(editor.getSelectedText(), null);
	});

	it("renders each selected grapheme with an underline highlight", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello world");
		editor.render(80);

		assert.strictEqual(editor.beginMouseSelection(0, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(5, 1, 80), true);

		const content = editor.render(80)[1]!;
		// Selected characters of "hello" are wrapped in \x1b[4m..\x1b[24m (underline);
		// the unselected "world" and the separating space are not.
		for (const ch of "hello") {
			assert.ok(content.includes(`\x1b[4m${ch}\x1b[24m`), `char ${ch} not underlined: ${JSON.stringify(content)}`);
		}
		assert.ok(!content.includes("\x1b[4mw\x1b[24m"), "unselected 'w' should not be underlined");
	});

	it("does not underline unselected characters", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello world");
		editor.render(80);

		assert.strictEqual(editor.beginMouseSelection(0, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(5, 1, 80), true);

		const content = editor.render(80)[1]!;
		// The selected range is exactly "hello". Every underline segment must be one of
		// those characters; nothing beyond must be underlined.
		const underlined = (content.match(/\x1b\[4m([^\x1b]*)\x1b\[24m/g) ?? []).map((m) =>
			m.replace(/\x1b\[4m|\x1b\[24m/g, ""),
		);
		assert.deepStrictEqual(underlined, ["h", "e", "l", "l", "o"]);
	});

	it("keyboard input clears the active mouse selection", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		editor.setText("hello world");
		editor.render(80);

		assert.strictEqual(editor.beginMouseSelection(0, 1, 80), true);
		assert.strictEqual(editor.extendMouseSelection(5, 1, 80), true);
		assert.strictEqual(editor.getSelectedText(), "hello");

		editor.handleInput("x");
		assert.strictEqual(editor.getSelectedText(), null);
	});

	it("correctly positions the cursor against the horizontal scroll indicator layout", () => {
		const editor = new Editor(createTestTUI(80), defaultEditorTheme);
		// 40 lines, viewport is min 5 rows. After rendering, move down so scrollOffset > 0.
		editor.setText(Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n"));
		editor.render(80);
		// Move to the last line to force scrolling.
		for (let index = 0; index < 30; index++) editor.handleInput("\x1b[B");

		editor.render(80);
		// Row 0 is now a scroll indicator, but content still starts at box row 1.
		assert.strictEqual(editor.positionCursorAtScreen(0, 1, 80), true);
		// We are on the last visible line; clicking column 0 maps to some column 0.
		assert.strictEqual(editor.getCursor().col, 0);
		// The cursor line must be within the logical 30 lines.
		assert.ok(editor.getCursor().line >= 0 && editor.getCursor().line < 30);
	});
});
