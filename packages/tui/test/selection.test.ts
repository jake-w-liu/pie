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

	it("coalesces rapid drag repaints to the render frame rate", async () => {
		const { terminal, tui } = await createSelectionTui();
		terminal.writes.length = 0;
		terminal.sendInput(press(2, 2));
		let releaseX = 2;
		let releaseY = 2;
		for (let index = 0; index < 1_000; index++) {
			releaseX = 2 + (index % 60);
			releaseY = 2 + (index % 10);
			terminal.sendInput(`\x1b[<32;${releaseX};${releaseY}M`);
		}

		assert.strictEqual(terminal.writes.length, 0, "mouse dispatch must not repaint synchronously per motion");
		await terminal.waitForRender();
		assert.strictEqual(terminal.writes.length, 1, "expected one coalesced selection frame");

		terminal.sendInput(release(releaseX, releaseY));
		await terminal.waitForRender();
		tui.stop();
	});

	it("a non-primary release cancels rather than finalizes a left drag", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;6;2M");
		terminal.sendInput("\x1b[<2;6;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), []);

		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("line 40")));
		tui.stop();
	});

	it("ignores selection input until row resize sequences have rendered", async () => {
		const { terminal, tui } = await createSelectionTui();
		terminal.resize(80, 30);
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(6, 2));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), []);

		// Returning to the prior dimensions before the queued frame must still
		// invalidate hit-testing; dimensions alone cannot detect this sequence.
		terminal.resize(80, 24);
		await terminal.waitForRender();
		terminal.resize(80, 30);
		terminal.resize(80, 24);
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(6, 2));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), []);

		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(6, 2));
		await terminal.waitForRender();
		assert.strictEqual(copiedTexts(terminal).length, 1, "selection must recover after resize rendering");
		tui.stop();
	});

	it("overlay transitions cancel an active drag and resume rendering", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(!(await terminal.flushAndGetViewport()).some((line) => line.includes("line 40")));

		const overlay = tui.showOverlay(new Text("dialog", 0, 0));
		overlay.hide();
		await terminal.waitForRender();
		const view = await terminal.flushAndGetViewport();
		assert.ok(view.some((line) => line.includes("line 40")));
		assert.ok(view.some((line) => line.includes("foot")));
		assert.deepStrictEqual(copiedTexts(terminal), []);
		tui.stop();
	});

	it("does not hit-test a hidden overlay before its replacement frame", async () => {
		const { terminal, tui } = await createSelectionTui();
		const overlay = tui.showOverlay(new Text("DIALOG", 0, 0), { row: 0, col: 0, width: 10 });
		await terminal.waitForRender();
		overlay.hide();
		terminal.sendInput(press(1, 1));
		terminal.sendInput(release(6, 1));
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), []);

		terminal.sendInput(press(1, 1));
		terminal.sendInput(release(6, 1));
		await terminal.waitForRender();
		assert.strictEqual(copiedTexts(terminal).length, 1);
		assert.notStrictEqual(copiedTexts(terminal)[0], "DIALOG");
		tui.stop();
	});

	it("an editor press resumes rendering after a lost transcript release", async () => {
		const { terminal, tui, transcript, editor } = await createSelectionTui();
		// Press in the transcript arms a drag, then the release is lost.
		terminal.sendInput(press(2, 2));
		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(!(await terminal.flushAndGetViewport()).some((line) => line.includes("line 40")));

		// A fresh press inside the editor (absolute rows 30-32, terminal rows
		// 21-23 in the frozen frame) must end the half-open drag and catch up.
		terminal.sendInput(press(40, 23));
		terminal.sendInput(release(40, 23));
		await terminal.waitForRender();
		const view = await terminal.flushAndGetViewport();
		assert.ok(
			view.some((line) => line.includes("line 40")),
			"expected streaming to resume",
		);
		assert.ok(
			view.some((line) => line.includes("foot")),
			"expected editor zone to return",
		);
		assert.deepStrictEqual(copiedTexts(terminal), []);
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
	});

	it("focus loss cancels a half-open selection and resumes rendering", async () => {
		const { terminal, tui, transcript, editor } = await createSelectionTui();
		const listenerInputs: string[] = [];
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		assert.ok(terminal.writes.join("").includes("\x1b[?1004h"), "focus reporting must be enabled");
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();

		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(!(await terminal.flushAndGetViewport()).some((line) => line.includes("line 40")));

		terminal.sendInput("\x1b[O");
		await terminal.waitForRender();
		assert.ok(!listenerInputs.includes("\x1b[O"), "focus reports must be consumed before input listeners");
		const view = await terminal.flushAndGetViewport();
		assert.ok(
			view.some((line) => line.includes("line 40")),
			"expected focus loss to resume rendering",
		);
		assert.ok(view.some((line) => line.includes("foot")));

		// Orphaned motion/release and explicit copy must not revive or copy the
		// partial selection that focus loss canceled.
		terminal.sendInput("\x1b[<32;6;2M");
		terminal.sendInput(release(6, 2));
		terminal.sendInput("\x1b[99;9u");
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), []);
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
		assert.ok(terminal.writes.join("").includes("\x1b[?1004l"), "focus reporting must be disabled");
	});

	it("Cmd+C completes a half-open selection and resumes rendering", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(!(await terminal.flushAndGetViewport()).some((line) => line.includes("line 40")));

		terminal.sendInput("\x1b[99;9u");
		await terminal.waitForRender();
		const view = await terminal.flushAndGetViewport();
		assert.ok(view.some((line) => line.includes("line 40")));
		assert.ok(view.some((line) => line.includes("foot")));
		assert.deepStrictEqual(copiedTexts(terminal), ["ine 1"]);
		tui.stop();
	});

	it("typing cancels a partial selection before the key reaches the editor", async () => {
		const { terminal, tui, editor } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();

		terminal.sendInput("x");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[99;9u");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "hellox");
		assert.deepStrictEqual(copiedTexts(terminal), []);
		tui.stop();
	});

	it("does not retain a half-open selection across stop and restart", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		tui.stop({ preserveScreen: true });

		tui.start();
		await terminal.waitForRender();
		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("line 40")));
		terminal.sendInput("\x1b[99;9u");
		await terminal.waitForRender();
		assert.deepStrictEqual(copiedTexts(terminal), []);
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

	it("holds streaming only during a drag and resumes on release", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;2;3M");
		await terminal.waitForRender();
		const held = await terminal.flushAndGetViewport();

		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(await terminal.flushAndGetViewport(), held, "dragging must keep coordinates stable");

		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();
		const resumed = await terminal.flushAndGetViewport();
		assert.ok(
			resumed.some((line) => line.includes("line 40")),
			"release must resume streaming",
		);
		assert.ok(
			resumed.some((line) => line.includes("foot")),
			"release must return to the input zone",
		);
		tui.stop();
	});

	it("preserves an explicit reading hold across selection", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput("\x1b[<64;40;2M");
		await terminal.waitForRender();
		terminal.sendInput(press(2, 2));
		terminal.sendInput(release(2, 3));
		await terminal.waitForRender();
		const held = await terminal.flushAndGetViewport();

		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(await terminal.flushAndGetViewport(), held, "selection must not discard reading mode");

		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("foot")));
		tui.stop();
	});

	it("focus loss preserves reading mode while canceling its active drag", async () => {
		const { terminal, tui, transcript } = await createSelectionTui();
		terminal.sendInput("\x1b[<64;40;2M");
		await terminal.waitForRender();
		terminal.sendInput(press(2, 2));
		terminal.sendInput("\x1b[<32;2;3M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[O");
		await terminal.waitForRender();
		const held = await terminal.flushAndGetViewport();

		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(await terminal.flushAndGetViewport(), held);
		assert.deepStrictEqual(copiedTexts(terminal), []);

		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("foot")));
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

	it("coalesces a rapid click burst into one clipboard operation", async () => {
		const copied: string[] = [];
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text(transcriptLines(30), 0, 0));
		tui.start();
		await terminal.waitForRender();

		for (let index = 0; index < 300; index++) {
			terminal.sendInput(press(2, 24));
			terminal.sendInput(release(2, 24));
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(copied.length, 1);
		tui.stop();
	});

	it("does not let an unresolved clipboard callback block a later copy", async () => {
		const copied: string[] = [];
		let finishFirst: ((copied: boolean) => void) | undefined;
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal, undefined, undefined, {
			copySelection: (text) => {
				copied.push(text);
				if (!finishFirst) {
					return new Promise<boolean>((resolve) => {
						finishFirst = resolve;
					});
				}
				return Promise.resolve(true);
			},
		});
		tui.addChild(new Text(transcriptLines(30), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(2, 24));
		terminal.sendInput(release(6, 24));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(copied.length, 1);

		terminal.sendInput(press(2, 23));
		terminal.sendInput(release(6, 23));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(copied.length, 2);

		if (!finishFirst) throw new Error("first clipboard callback did not start");
		finishFirst(false);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(copiedTexts(terminal), [], "a stale failure must not overwrite the newer clipboard");
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

	for (const action of ["drag", "wheel"] as const) {
		it(`preserves the final cell of a full-width row during ${action}`, async (t) => {
			const { terminal, tui, transcript } = await createSelectionTui();
			t.after(() => tui.stop());
			const text = "x".repeat(terminal.columns);
			transcript.setText(Array.from({ length: 30 }, () => text).join("\n"));
			tui.requestRender();
			await terminal.waitForRender();
			if (action === "drag") {
				terminal.sendInput(press(1, 2));
				terminal.sendInput("\x1b[<32;80;2M");
			} else {
				terminal.sendInput("\x1b[<64;40;2M");
			}
			await terminal.waitForRender();
			assert.strictEqual(terminal.getViewport()[1], text);
		});
	}

	it("does not interpret repeated drags as double-clicks", async (t) => {
		const { terminal, tui } = await createSelectionTui();
		t.after(() => tui.stop());
		for (let index = 0; index < 3; index++) {
			terminal.sendInput(press(2, 2));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.strictEqual(copiedTexts(terminal).length, index, "drag must copy only on release");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput(release(4, 2));
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		assert.deepStrictEqual(copiedTexts(terminal), ["ine", "ine", "ine"]);
	});

	for (const button of [66, 67, 70, 71, 82, 83]) {
		it(`ignores horizontal wheel ${button} without holding live rendering`, async (t) => {
			const { terminal, tui, transcript } = await createSelectionTui();
			t.after(() => tui.stop());
			terminal.sendInput(press(2, 2));
			terminal.sendInput(release(6, 2));
			terminal.sendInput(`\x1b[<${button};40;2M`);
			transcript.setText(transcriptLines(40));
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("line 40")));
			assert.ok(terminal.getViewport().some((line) => line.includes("foot")));
		});
	}

	for (const transition of ["overlay", "restart"] as const) {
		it(`restores the live viewport after ${transition} without a content mutation`, async (t) => {
			const { terminal, tui } = await createSelectionTui();
			t.after(() => tui.stop());
			const live = terminal.getViewport();
			terminal.sendInput("\x1b[<64;40;2M");
			await terminal.waitForRender();
			assert.notDeepStrictEqual(terminal.getViewport(), live);
			if (transition === "overlay") {
				tui.showOverlay(new Text("dialog", 0, 0)).hide();
			} else {
				tui.stop({ preserveScreen: true });
				tui.start();
			}
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport(), live);
		});
	}

	for (const rewrite of [false, true]) {
		it(`cancels a drag when a listener ${rewrite ? "rewrites" : "consumes"} its release`, async (t) => {
			const { terminal, tui, transcript, editor } = await createSelectionTui();
			t.after(() => tui.stop());
			tui.addInputListener((data) => {
				if (data === release(6, 2)) return rewrite ? { data: "" } : { consume: true };
				return undefined;
			});
			terminal.sendInput(press(2, 2));
			terminal.sendInput("\x1b[<32;6;2M");
			terminal.sendInput(release(6, 2));
			transcript.setText(transcriptLines(40));
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("line 40")));
			assert.strictEqual(editor.getText(), "hello");
			assert.deepStrictEqual(copiedTexts(terminal), [], "consumed releases must not copy a partial selection");
		});
	}

	for (const [text, start, end, expected] of [
		["abcdef", 5, 2, "bcde"],
		["a界b好c", 5, 2, "界b好"],
		["ae\u0301bcd", 4, 2, "e\u0301bc"],
	] as const) {
		it(`includes both endpoint graphemes when selecting ${JSON.stringify(text)} backwards`, async (t) => {
			const { terminal, tui, transcript } = await createSelectionTui();
			t.after(() => tui.stop());
			transcript.setText(Array.from({ length: 30 }, () => text).join("\n"));
			tui.requestRender();
			await terminal.waitForRender();
			terminal.sendInput(press(start, 2));
			terminal.sendInput(`\x1b[<32;${end};2M`);
			await terminal.waitForRender();
			assert.ok(terminal.writes.join("").includes(`\x1b[7m${expected}`));
			terminal.sendInput(release(end, 2));
			await terminal.waitForRender();
			assert.deepStrictEqual(copiedTexts(terminal), [expected]);
		});
	}

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
