import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { Container, isMouseDragMotion, isPrimaryMousePress, parseSgrMouseEvent } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function click(x1Based: number, y1Based: number): string {
	return `\x1b[<0;${x1Based};${y1Based}M`;
}

describe("SGR mouse parsing", () => {
	it("parses press coordinates as 0-based", () => {
		assert.deepStrictEqual(parseSgrMouseEvent("\x1b[<0;7;4M"), { button: 0, x: 6, y: 3, press: true });
	});

	it("parses release events", () => {
		assert.deepStrictEqual(parseSgrMouseEvent("\x1b[<0;7;4m"), { button: 0, x: 6, y: 3, press: false });
	});

	it("keeps modifier bits on the button code", () => {
		assert.deepStrictEqual(parseSgrMouseEvent("\x1b[<4;7;4M"), { button: 4, x: 6, y: 3, press: true });
	});

	it("rejects non-mouse input", () => {
		assert.strictEqual(parseSgrMouseEvent("\x1b[A"), undefined);
		assert.strictEqual(parseSgrMouseEvent("hello"), undefined);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;7;4Mextra"), undefined);
		assert.strictEqual(parseSgrMouseEvent("\x1b[<0;0;4M"), undefined);
	});

	it("accepts left presses (with modifiers) but not wheel, motion, or release", () => {
		assert.strictEqual(isPrimaryMousePress({ button: 0, x: 0, y: 0, press: true }), true);
		assert.strictEqual(isPrimaryMousePress({ button: 4, x: 0, y: 0, press: true }), true);
		assert.strictEqual(isPrimaryMousePress({ button: 0, x: 0, y: 0, press: false }), false);
		assert.strictEqual(isPrimaryMousePress({ button: 1, x: 0, y: 0, press: true }), false);
		assert.strictEqual(isPrimaryMousePress({ button: 2, x: 0, y: 0, press: true }), false);
		assert.strictEqual(isPrimaryMousePress({ button: 64, x: 0, y: 0, press: true }), false);
		assert.strictEqual(isPrimaryMousePress({ button: 32, x: 0, y: 0, press: true }), false);
	});

	it("detects unmodified left drag motion only", () => {
		assert.strictEqual(isMouseDragMotion({ button: 32, x: 1, y: 1, press: true }), true);
		assert.strictEqual(isMouseDragMotion({ button: 36, x: 1, y: 1, press: true }), false);
		assert.strictEqual(isMouseDragMotion({ button: 33, x: 1, y: 1, press: true }), false);
		assert.strictEqual(isMouseDragMotion({ button: 32, x: 1, y: 1, press: false }), false);
		assert.strictEqual(isMouseDragMotion({ button: 0, x: 1, y: 1, press: true }), false);
		assert.strictEqual(isMouseDragMotion({ button: 64, x: 1, y: 1, press: true }), false);
	});
});

describe("Editor click-to-cursor", () => {
	function createEditor(text: string, width = 80): Editor {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), defaultEditorTheme);
		editor.setText(text);
		editor.render(width);
		return editor;
	}

	it("moves the cursor to the clicked character", () => {
		const editor = createEditor("hello world");
		// Row 0 is the top border; "hello world" starts at row 1, 'w' is column 6.
		assert.strictEqual(editor.handleMousePress(6, 1), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
	});

	it("moves the cursor when clicking past the end of the line", () => {
		const editor = createEditor("hi");
		assert.strictEqual(editor.handleMousePress(30, 1), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("ignores clicks on the borders", () => {
		const editor = createEditor("hello");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		assert.strictEqual(editor.handleMousePress(2, 0), false);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		// Single-line editor renders 3 rows (border, text, border); row 2 is the bottom border.
		assert.strictEqual(editor.handleMousePress(2, 2), false);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
	});

	it("maps clicks to the correct buffer line in multiline text", () => {
		const editor = createEditor("ab\ncdef");
		assert.strictEqual(editor.handleMousePress(2, 2), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 2 });
	});

	it("maps clicks inside wrapped visual lines", () => {
		// Width 40 leaves a 39-column layout; 100 chars wrap into 39/39/22.
		const editor = createEditor("a".repeat(100), 40);
		assert.strictEqual(editor.handleMousePress(0, 2), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 39 });
		assert.strictEqual(editor.handleMousePress(5, 3), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 83 });
	});

	it("places the cursor before a wide character cell", () => {
		const editor = createEditor("a中b");
		// Columns: a=[0], 中=[1,3), b=[3]. Clicking column 1 hits 中.
		assert.strictEqual(editor.handleMousePress(1, 1), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		assert.strictEqual(editor.handleMousePress(3, 1), true);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("requires a render before handling clicks", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		assert.strictEqual(editor.handleMousePress(2, 1), false);
	});
});

describe("Main-screen click routing", () => {
	it("routes clicks to the focused editor and keeps mouse bytes out of the text", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text("line1\nline2", 0, 0));
		tui.addChild(editor);
		tui.addChild(new Text("foot", 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		// Padded first frame (24 rows): 18 blanks + 2 transcript + 3 editor
		// (border, text, border) + 1 footer. The editor text row is absolute
		// row 21, i.e. 1-based terminal row 22.
		terminal.sendInput(click(4, 22));
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		// The release event must not leak into the text either.
		terminal.sendInput("\x1b[<0;4;4m");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		assert.strictEqual(editor.getText(), "hello");

		tui.stop();
	});

	it("finds a nested focused editor without rendering the transcript", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(new Text("line1\nline2", 0, 0));
		tui.addChild(editorContainer);
		tui.addChild(new Text("foot", 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(click(2, 22));
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

		tui.stop();
	});

	it("ignores clicks landing in the transcript", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text("line1\nline2", 0, 0));
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(click(3, 19));
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		assert.strictEqual(editor.getText(), "hello");

		tui.stop();
	});

	it("enables mouse reporting on start and disables it on stop", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Text("hi", 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.ok(
			terminal.writes.some(
				(data) => data.includes("\x1b[?1000h") && data.includes("\x1b[?1002h") && data.includes("\x1b[?1006h"),
			),
			"start should enable button and motion tracking with SGR coordinates",
		);
		tui.stop();
		assert.ok(
			terminal.writes.some(
				(data) => data.includes("\x1b[?1000l") && data.includes("\x1b[?1002l") && data.includes("\x1b[?1006l"),
			),
			"stop should disable mouse reporting",
		);
	});

	it("skips mouse reporting when PI_MOUSE=0", async () => {
		const previous = process.env.PI_MOUSE;
		process.env.PI_MOUSE = "0";
		try {
			const terminal = new RecordingTerminal(80, 24);
			const tui = new TuiMainScreen(terminal);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("hello");
			tui.addChild(editor);
			tui.setFocus(editor);
			tui.start();
			await terminal.waitForRender();
			assert.ok(
				terminal.writes.every((data) => !data.includes("\x1b[?1000h")),
				"start must not enable mouse reporting",
			);
			terminal.sendInput(click(1, 2));
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
			tui.stop();
		} finally {
			if (previous === undefined) delete process.env.PI_MOUSE;
			else process.env.PI_MOUSE = previous;
		}
	});
});
