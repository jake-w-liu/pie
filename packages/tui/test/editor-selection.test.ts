import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor, wordBoundaries } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
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

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("selection edits through real input", () => {
	for (const data of ["X", "\x1b[88u", "\x1b[27;1;88~", "\x1b[200~X\x1b[201~"]) {
		it(`replaces a mouse selection via ${JSON.stringify(data)} with one change and undo unit`, () => {
			const editor = createEditor("hello brave world");
			editor.handleMousePress(6, 1);
			editor.handleMouseDrag(11, 1);
			const changes: string[] = [];
			editor.onChange = (text) => changes.push(text);
			editor.handleInput(data);
			assert.strictEqual(editor.getText(), "hello X world");
			assert.strictEqual(editor.hasSelection(), false);
			assert.deepStrictEqual(changes, ["hello X world"]);
			editor.handleInput("\x1f"); // default undo
			assert.strictEqual(editor.getText(), "hello brave world");
			assert.strictEqual(editor.hasSelection(), false);
		});
	}

	for (const pasted of ["small\npaste", "x".repeat(1200)]) {
		it(`atomically replaces a reversed multiline selection with a ${pasted.length}-character paste`, () => {
			const editor = createEditor("before one\ntwo after", 10);
			editor.setSelection({ line: 1, col: 3 }, { line: 0, col: 7 });
			const changes: string[] = [];
			editor.onChange = (text) => changes.push(text);
			editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
			assert.strictEqual(editor.getExpandedText(), `before ${pasted} after`);
			assert.strictEqual(changes.length, 1);
			editor.handleInput("\x1f");
			assert.strictEqual(editor.getExpandedText(), "before one\ntwo after");
		});
	}

	it("preserves typing coalescing but starts a new undo unit for a selection replacement", () => {
		const editor = createEditor("");
		editor.handleInput("a");
		editor.handleInput("b");
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 2 });
		editor.handleInput("c");
		editor.handleInput("d");
		editor.handleInput("\x1f");
		assert.strictEqual(editor.getText(), "ab");
		editor.handleInput("\x1f");
		assert.strictEqual(editor.getText(), "");
	});

	for (const data of ["\x7f", "\x1b[3~"]) {
		it(`notifies exactly once for selected-range deletion via ${JSON.stringify(data)}`, () => {
			const editor = createEditor("one\ntwo\nthree");
			editor.setSelection({ line: 0, col: 1 }, { line: 2, col: 2 });
			const changes: string[] = [];
			editor.onChange = (text) => changes.push(text);
			editor.handleInput(data);
			assert.deepStrictEqual(changes, ["oree"]);
			editor.handleInput("\x1f");
			assert.strictEqual(editor.getText(), "one\ntwo\nthree");
		});
	}

	it("notifies once for programmatic replacement and direct selection deletion", () => {
		const editor = createEditor("abc");
		const changes: string[] = [];
		editor.onChange = (text) => changes.push(text);
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 2 });
		editor.insertTextAtCursor("X");
		assert.deepStrictEqual(changes, ["Xc"]);
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 1 });
		editor.deleteSelection();
		assert.deepStrictEqual(changes, ["Xc", "c"]);
	});
});

describe("selection invalidation at buffer transitions", () => {
	it("clears setText selections before change callbacks can reenter editing", () => {
		const editor = createEditor("first\nsecond");
		editor.setSelection({ line: 1, col: 0 }, { line: 1, col: 6 });
		let reentered = false;
		editor.onChange = () => {
			assert.strictEqual(editor.hasSelection(), false);
			if (!reentered) {
				reentered = true;
				editor.handleInput("\x7f");
			}
		};
		editor.setText("new");
		assert.strictEqual(editor.getText(), "ne");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("clears selection on submission before callbacks populate the next prompt", () => {
		const editor = createEditor("selected text");
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 8 });
		editor.onSubmit = (text) => {
			assert.strictEqual(text, "selected text");
			assert.strictEqual(editor.hasSelection(), false);
			editor.setText("next");
		};
		editor.handleInput("\r");
		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "nex");
	});

	it("clears selection when undo restores a shorter document", () => {
		const editor = createEditor("short");
		editor.setText("long\nsecond line");
		editor.setSelection({ line: 1, col: 0 }, { line: 1, col: 11 });
		editor.handleInput("\x1f");
		assert.strictEqual(editor.hasSelection(), false);
		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "shor");
	});

	it("clears selection both when browsing history and restoring the draft", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = createEditor("draft");
		editor.addToHistory("old\nhistory");
		editor.setSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
		editor.handleInput("\x10");
		assert.strictEqual(editor.hasSelection(), false);
		editor.setSelection({ line: 1, col: 0 }, { line: 1, col: 7 });
		editor.handleInput("\x0e");
		assert.strictEqual(editor.hasSelection(), false);
		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "draf");
	});

	it("rejects invalid selection coordinates without changing text", () => {
		const editor = createEditor("abc");
		for (const position of [
			{ line: 2, col: 1 },
			{ line: 0, col: -1 },
			{ line: 0, col: 9 },
			{ line: 0, col: NaN },
		]) {
			editor.setSelection({ line: 0, col: 0 }, position);
			assert.strictEqual(editor.hasSelection(), false);
			assert.strictEqual(editor.deleteSelection(), false);
			assert.strictEqual(editor.getText(), "abc");
		}
	});
});

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
