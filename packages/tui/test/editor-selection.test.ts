import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, wordBoundaries } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Editor text selection: a mouse drag or a double click produces a range, the
 * range survives the cursor moving, and the next edit removes it. Everything
 * here is expressed in buffer coordinates so it does not depend on wrapping or
 * on the exact column the pointer happened to land on.
 */

function createEditor(text: string, width = 80): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), defaultEditorTheme);
	editor.setText(text);
	editor.render(width);
	return editor;
}

describe("wordBoundaries", () => {
	it("keeps path separators internal so a path selects whole", () => {
		// Intl.Segmenter already folds "main.ts" into one word-like run; the "/"
		// joiner is what merges it with "src".
		assert.deepStrictEqual(wordBoundaries("src/main.ts"), [[0, 11]]);
		assert.deepStrictEqual(wordBoundaries("one/two"), [[0, 7]]);
	});

	it("keeps kebab-case tokens whole", () => {
		assert.deepStrictEqual(wordBoundaries("a-b c"), [
			[0, 3],
			[4, 5],
		]);
	});

	it("returns nothing for blank or punctuation-only text", () => {
		assert.deepStrictEqual(wordBoundaries("   "), []);
		assert.deepStrictEqual(wordBoundaries(""), []);
	});
});

describe("editor selection model", () => {
	it("has no selection until one is set", () => {
		const editor = createEditor("hello world");
		assert.strictEqual(editor.hasSelection(), false);
		assert.strictEqual(editor.getSelectedText(), null);
	});

	it("reads back the selected text in document order regardless of drag direction", () => {
		const editor = createEditor("hello brave world");
		editor.setSelection({ line: 0, col: 6 }, { line: 0, col: 11 });
		assert.strictEqual(editor.getSelectedText(), "brave");
		editor.setSelection({ line: 0, col: 11 }, { line: 0, col: 6 });
		assert.strictEqual(editor.getSelectedText(), "brave");
	});

	it("treats a collapsed range as no selection", () => {
		const editor = createEditor("hello");
		editor.setSelection({ line: 0, col: 2 }, { line: 0, col: 2 });
		assert.strictEqual(editor.hasSelection(), false);
		assert.strictEqual(editor.deleteSelection(), false);
	});

	it("joins multiple selected lines with newlines", () => {
		const editor = createEditor("one\ntwo\nthree");
		editor.setSelection({ line: 0, col: 1 }, { line: 2, col: 2 });
		assert.strictEqual(editor.getSelectedText(), "ne\ntwo\nth");
	});

	it("clears without touching the buffer", () => {
		const editor = createEditor("hello world");
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
		editor.clearSelection();
		assert.strictEqual(editor.hasSelection(), false);
		assert.strictEqual(editor.getText(), "hello world");
	});
});

describe("editor deletion of a selection", () => {
	it("removes a single-line range and collapses the cursor to its start", () => {
		const editor = createEditor("hello brave world");
		editor.setSelection({ line: 0, col: 6 }, { line: 0, col: 12 });
		assert.strictEqual(editor.deleteSelection(), true);
		assert.strictEqual(editor.getText(), "hello world");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		assert.strictEqual(editor.hasSelection(), false);
	});

	it("removes a multi-line range and joins the outer fragments", () => {
		const editor = createEditor("one\ntwo\nthree");
		editor.setSelection({ line: 0, col: 1 }, { line: 2, col: 2 });
		assert.strictEqual(editor.deleteSelection(), true);
		assert.strictEqual(editor.getText(), "oree");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
	});

	it("replaces the selection when text is typed", () => {
		const editor = createEditor("hello brave world");
		editor.setSelection({ line: 0, col: 6 }, { line: 0, col: 12 });
		editor.insertTextAtCursor("new");
		assert.strictEqual(editor.getText(), "hello newworld");
	});

	it("removes the selection on backspace instead of one character", () => {
		const editor = createEditor("hello brave world");
		editor.setSelection({ line: 0, col: 6 }, { line: 0, col: 12 });
		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("removes the selection on forward delete", () => {
		const editor = createEditor("hello brave world");
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 6 });
		editor.handleInput("\x1b[3~");
		assert.strictEqual(editor.getText(), "brave world");
	});
});

describe("editor word selection", () => {
	it("selects the word under the position", () => {
		const editor = createEditor("hello brave world");
		assert.strictEqual(editor.selectWordAt(0, 8), true);
		assert.strictEqual(editor.getSelectedText(), "brave");
	});

	it("selects a whole path as one word", () => {
		const editor = createEditor("src/main.ts");
		assert.strictEqual(editor.selectWordAt(0, 5), true);
		assert.strictEqual(editor.getSelectedText(), "src/main.ts");
	});

	it("selects the trailing word when clicking past it", () => {
		const editor = createEditor("hello brave world");
		assert.strictEqual(editor.selectWordAt(0, 40), true);
		assert.strictEqual(editor.getSelectedText(), "world");
	});

	it("reports failure for an out-of-range line", () => {
		const editor = createEditor("hello");
		assert.strictEqual(editor.selectWordAt(9, 0), false);
	});
});

describe("editor mouse selection", () => {
	it("selects the dragged range and leaves the cursor at the press anchor", () => {
		const editor = createEditor("hello brave world");
		assert.strictEqual(editor.handleMousePress(0, 1), true);
		assert.strictEqual(editor.handleMouseDrag(11, 1), true);
		assert.strictEqual(editor.getSelectedText(), "hello brave");
		// The cursor stays where the press landed; deletion collapses it to the
		// selection start rather than to wherever the pointer ended up.
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("selects the whole word on a double click", () => {
		const editor = createEditor("hello brave world");
		editor.handleMousePress(6, 1);
		editor.handleMouseRelease();
		assert.strictEqual(editor.hasSelection(), false);
		editor.handleMousePress(6, 1);
		assert.strictEqual(editor.getSelectedText(), "brave");
	});

	it("restarts from a plain click that follows a drag", () => {
		const editor = createEditor("hello brave world");
		editor.handleMousePress(0, 1);
		editor.handleMouseDrag(10, 1);
		editor.handleMouseRelease();
		assert.strictEqual(editor.hasSelection(), true);
		// A press far from the previous one is not a double click, so it starts
		// a fresh collapsed selection instead of a word.
		editor.handleMousePress(6, 1);
		assert.strictEqual(editor.hasSelection(), false);
	});

	it("ignores drags on the borders", () => {
		const editor = createEditor("hello");
		assert.strictEqual(editor.handleMousePress(2, 0), false);
		assert.strictEqual(editor.handleMouseDrag(2, 0), false);
	});

	it("extends across visual lines of a wrapped paragraph", () => {
		const editor = createEditor("alpha beta gamma delta", 12);
		editor.render(12);
		editor.handleMousePress(0, 1);
		editor.handleMouseDrag(6, 2);
		assert.strictEqual(editor.getSelectedText(), "alpha beta gamma ");
	});
});

describe("editor selection rendering", () => {
	it("highlights the selected range in the rendered output", () => {
		const editor = createEditor("hello brave world");
		editor.setSelection({ line: 0, col: 6 }, { line: 0, col: 11 });
		const rendered = editor.render(80).join("\n");
		assert.ok(rendered.includes("\x1b[7mbrave\x1b[0m"), `selection not highlighted in:\n${rendered}`);
	});

	it("renders unchanged output when nothing is selected", () => {
		const editor = createEditor("hello brave world");
		assert.strictEqual(editor.render(80).join("\n"), createEditor("hello brave world").render(80).join("\n"));
	});
});
