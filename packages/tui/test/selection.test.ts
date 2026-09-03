import assert from "node:assert";
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
});
