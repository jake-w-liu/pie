import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
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

function transcriptLines(count: number): string {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

async function createSelectionTui(): Promise<{
	terminal: RecordingTerminal;
	tui: TuiMainScreen;
	transcript: Text;
	editor: Editor;
}> {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const transcript = new Text(transcriptLines(30), 0, 0);
	const editor = new Editor(tui, defaultEditorTheme);
	editor.setText("hello");
	tui.addChild(transcript);
	tui.addChild(editor);
	tui.addChild(new Text("foot", 0, 0));
	tui.setFocus(editor);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, transcript, editor };
}

function press(x1Based: number, y1Based: number): string {
	return `\x1b[<0;${x1Based};${y1Based}M`;
}

function release(x1Based: number, y1Based: number): string {
	return `\x1b[<0;${x1Based};${y1Based}m`;
}

/** Decode every OSC 52 clipboard payload written so far. */
function copiedTexts(terminal: RecordingTerminal): string[] {
	return terminal.writes
		.join("")
		.split("\x1b]52;c;")
		.slice(1)
		.map((part) => part.slice(0, part.indexOf("\x07")))
		.filter((payload) => payload.length > 0)
		.map((payload) => Buffer.from(payload, "base64").toString("utf-8"));
}

// Layout: 30 transcript rows + 3 editor rows + 1 footer row = 34 rows.
// Transcript row N (0-based) is absolute row N; terminal row = absolute - 10.
describe("Transcript text selection", () => {
	it("drags select a range, highlights it, and copies it", async () => {
		const { terminal, tui, editor } = await createSelectionTui();
		// Press on "line 12" (absolute row 11, terminal row 2) at column 1.
		terminal.sendInput(press(2, 2));
		// Release on "line 13" (absolute row 12, terminal row 3) at column 1.
		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();

		assert.deepStrictEqual(copiedTexts(terminal), ["ine 12\nli"]);
		const writes = terminal.writes.join("");
		assert.ok(writes.includes("\x1b[7mine 12"), "expected highlighted selection");
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
	});

	it("highlights live while dragging and copies once on release", async () => {
		const { terminal, tui, editor } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		// Drag motion to column 5 of the same row: highlight must appear
		// before release, with nothing copied yet.
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		assert.ok(terminal.writes.join("").includes("\x1b[7mine 1"), "expected live highlight");
		assert.deepStrictEqual(copiedTexts(terminal), []);

		terminal.sendInput(release(6, 2));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), ["ine 1"]);
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
	});

	it("ignores drag motion without a press", async () => {
		const { terminal, tui, editor } = await createSelectionTui();
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		assert.ok(!terminal.writes.join("").includes("\x1b[7mine 1"));
		assert.deepStrictEqual(copiedTexts(terminal), []);
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
	});

	it("double-click selects a word and triple-click selects the line", async () => {
		const { terminal, tui } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(2, 2));
		terminal.sendInput(press(2, 2));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), ["line"]);

		terminal.sendInput(release(2, 2));
		terminal.sendInput(press(2, 2));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), ["line", "line 12"]);
		tui.stop();
	});

	it("single click clears the selection without copying", async () => {
		const { terminal, tui } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(10, 2));
		await terminal.waitForRender();
		assert.strictEqual(copiedTexts(terminal).length, 1);

		terminal.sendInput(press(5, 5));
		terminal.sendInput(release(5, 5));
		await terminal.waitForRender();
		assert.strictEqual(copiedTexts(terminal).length, 1);
		tui.stop();
	});

	it("selecting holds the viewport so streaming output cannot yank it", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();
		const held = await terminal.flushAndGetViewport();

		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(await terminal.flushAndGetViewport(), held);
		tui.stop();
	});

	it("clicking the editor clears the selection and still moves the cursor", async () => {
		const { terminal, tui, editor } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(10, 2));
		await terminal.waitForRender();
		assert.strictEqual(copiedTexts(terminal).length, 1);

		// Editor text row is absolute row 31, i.e. terminal row 22 (1-based).
		terminal.sendInput(press(4, 22));
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		assert.strictEqual(copiedTexts(terminal).length, 1);
		tui.stop();
	});

	it("stays inert when mouse reporting is disabled", async () => {
		const previous = process.env.PI_MOUSE;
		process.env.PI_MOUSE = "0";
		try {
			const { terminal, tui, editor } = await createSelectionTui();
			terminal.sendInput(press(2, 2));
			terminal.sendInput(release(10, 2));
			await terminal.waitForRender();
			assert.deepStrictEqual(copiedTexts(terminal), []);
			assert.strictEqual(editor.getText(), "hello");
			tui.stop();
		} finally {
			if (previous === undefined) delete process.env.PI_MOUSE;
			else process.env.PI_MOUSE = previous;
		}
	});

	it("maps clicks onto short content in a used terminal", async () => {
		const terminal = new RecordingTerminal(80, 24);
		// Simulate a used terminal: shell history above, cursor partway down.
		// The first frame bottom-anchors (shell scrolls into scrollback), so
		// the 2 transcript rows land on screen rows 19-20 and the editor text
		// row on screen row 22 (1-based row 23).
		for (let index = 1; index <= 10; index++) terminal.write(`shell ${index}\r\n`);
		await terminal.flush();
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text("line1\nline2", 0, 0));
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		// Clicking column 3 of the editor text row must land at char 3, and
		// the shell history must survive in the scrollback above.
		terminal.sendInput(press(4, 23));
		terminal.sendInput(release(4, 23));
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		assert.strictEqual(editor.getText(), "hello");
		assert.ok(terminal.getScrollBuffer().some((line) => line.includes("shell 1")));
		tui.stop();
	});

	it("prefers the injected clipboard over OSC 52", async () => {
		const copied: string[] = [];
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text(transcriptLines(30), 0, 0));
		tui.addChild(editor);
		tui.addChild(new Text("foot", 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();
		assert.deepStrictEqual(copied, ["ine 12\nli"]);
		assert.ok(!terminal.writes.join("").includes("\x1b]52;c;"));
		tui.stop();
	});

	it("falls back to OSC 52 when the injected clipboard fails", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal, undefined, undefined, {
			copySelection: async () => false,
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text(transcriptLines(30), 0, 0));
		tui.addChild(editor);
		tui.addChild(new Text("foot", 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), ["ine 12\nli"]);
		tui.stop();
	});

	it("copies the active selection on Cmd+C and keeps it", async () => {
		const copied: string[] = [];
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text(transcriptLines(30), 0, 0));
		tui.addChild(editor);
		tui.addChild(new Text("foot", 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();
		assert.deepStrictEqual(copied, ["ine 12\nli"]);

		// Cmd+C arrives as CSI-u with the super modifier under Kitty protocol.
		terminal.sendInput("\x1b[99;9u");
		await terminal.waitForRender();
		assert.deepStrictEqual(copied, ["ine 12\nli", "ine 12\nli"]);
		assert.strictEqual(editor.getText(), "hello");
		assert.ok(terminal.writes.join("").includes("\x1b[7mine 12"));
		tui.stop();
	});

	it("lets Cmd+C through without a selection", async () => {
		const copied: string[] = [];
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello");
		tui.addChild(new Text("line", 0, 0));
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[99;9u");
		await terminal.waitForRender();
		assert.deepStrictEqual(copied, []);
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
	});

	it("recovers live follow when wheel arrives with stale geometry", async () => {
		const { terminal, tui } = await createSelectionTui();
		terminal.sendInput("\x1b[<64;40;2M");
		await terminal.waitForRender();

		// Resize faster than the render pipeline, then wheel immediately with
		// stale bookkeeping: must resume instead of wedging.
		terminal.resize(100, 24);
		terminal.sendInput("\x1b[<64;40;2M");
		await terminal.waitForRender();
		const view = (await terminal.flushAndGetViewport()).map((line) => line.trimEnd());
		assert.ok(
			view.some((line) => line.includes("foot")),
			"expected recovery to latest",
		);

		// Wheel works normally afterward.
		terminal.sendInput("\x1b[<64;40;2M");
		await terminal.waitForRender();
		const moved = (await terminal.flushAndGetViewport()).map((line) => line.trimEnd());
		assert.ok(!moved.some((line) => line.includes("foot")), "expected scroll-up to move");
		tui.stop();
	});

	it("writes mouse diagnostics to pi-mouse.log when enabled", async () => {
		const previous = process.env.PI_DEBUG_MOUSE;
		const logDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mouse-test-"));
		process.env.PI_DEBUG_MOUSE = "1";
		try {
			const terminal = new RecordingTerminal(80, 24);
			const tui = new TuiMainScreen(terminal, undefined, logDirectory);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("hello");
			tui.addChild(new Text(transcriptLines(30), 0, 0));
			tui.addChild(editor);
			tui.addChild(new Text("foot", 0, 0));
			tui.setFocus(editor);
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput(press(2, 2));
			terminal.sendInput(release(2, 3));
			terminal.sendInput("\x1b[<64;40;2M");
			await terminal.waitForRender();
			tui.stop();

			const log = await fs.readFile(path.join(logDirectory, "pi-mouse.log"), "utf8");
			assert.ok(log.includes("press"), "expected press entry");
			assert.ok(log.includes("release"), "expected release entry");
			assert.ok(log.includes("wheel"), "expected wheel entry");
		} finally {
			if (previous === undefined) delete process.env.PI_DEBUG_MOUSE;
			else process.env.PI_DEBUG_MOUSE = previous;
			await fs.rm(logDirectory, { recursive: true, force: true });
		}
	});
});
