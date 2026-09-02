import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

function transcriptLines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

async function createReadingTui(totalTranscriptLines = 30): Promise<{
	terminal: VirtualTerminal;
	tui: TuiMainScreen;
	transcript: Text;
	editor: Editor;
}> {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const transcript = new Text(transcriptLines(totalTranscriptLines), 0, 0);
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

async function viewport(terminal: VirtualTerminal): Promise<string[]> {
	return (await terminal.flushAndGetViewport()).map((line) => line.trimEnd());
}

describe("Hold-to-read viewport", () => {
	it("wheel-up freezes the view so streaming output never yanks it", async () => {
		const { terminal, tui, transcript } = await createReadingTui(30);
		const before = await viewport(terminal);

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		const held = await viewport(terminal);
		assert.notDeepStrictEqual(held, before);
		assert.ok(held[0]!.includes("line 8"), `expected older content, got ${held[0]}`);

		// Stream more content while held: the visible view must not move.
		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(await viewport(terminal), held);
		tui.stop();
	});

	it("wheel-down back to the bottom resumes live follow", async () => {
		const { terminal, tui, transcript } = await createReadingTui(30);
		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		for (let i = 0; i < 20; i++) {
			terminal.sendInput(WHEEL_DOWN);
			await terminal.waitForRender();
		}
		const resumed = await viewport(terminal);
		assert.ok(
			resumed.some((line) => line.includes("foot")),
			`expected latest content: ${resumed.at(-3)}`,
		);

		// New content follows again after resume.
		transcript.setText(transcriptLines(40));
		tui.requestRender();
		await terminal.waitForRender();
		const followed = await viewport(terminal);
		assert.ok(
			followed.some((line) => line.includes("line 40")),
			`expected follow: ${followed.at(-4)}`,
		);
		tui.stop();
	});

	it("Down resumes live follow and still reaches the editor", async () => {
		const { terminal, tui, editor } = await createReadingTui(30);
		editor.setText("aa\nbb");
		editor.handleInput("\x1b[A");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		const resumed = await viewport(terminal);
		assert.ok(
			resumed.some((line) => line.includes("foot")),
			"expected return to latest",
		);
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 2 });
		tui.stop();
	});

	it("typing resumes live follow", async () => {
		const { terminal, tui, editor } = await createReadingTui(30);
		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		terminal.sendInput("z");
		await terminal.waitForRender();
		const resumed = await viewport(terminal);
		assert.ok(
			resumed.some((line) => line.includes("foot")),
			"expected return to latest",
		);
		assert.strictEqual(editor.getText(), "helloz");
		tui.stop();
	});

	it("PageUp holds only when older rows exist; otherwise the editor keeps it", async () => {
		const { terminal, tui } = await createReadingTui(30);
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		const held = await viewport(terminal);
		assert.ok(held[0]!.includes("line 1"), `expected oldest content, got ${held[0]}`);
		tui.stop();

		const shortTerminal = new VirtualTerminal(80, 24);
		const shortTui = new TuiMainScreen(shortTerminal);
		const shortTranscript = new Text("top", 0, 0);
		const shortEditor = new Editor(shortTui, defaultEditorTheme);
		shortEditor.setText("hi");
		shortTui.addChild(shortTranscript);
		shortTui.addChild(shortEditor);
		shortTui.setFocus(shortEditor);
		shortTui.start();
		await shortTerminal.waitForRender();
		shortTerminal.sendInput("\x1b[5~");
		await shortTerminal.waitForRender();
		// Nothing to read above, so no hold: later content still follows.
		assert.strictEqual(shortEditor.getText(), "hi");
		shortTranscript.setText(`${transcriptLines(30)}\nbottom`);
		shortTui.requestRender();
		await shortTerminal.waitForRender();
		assert.ok((await viewport(shortTerminal)).some((line) => line.includes("bottom")));
		shortTui.stop();
	});

	it("clicks in the transcript stay inert while held", async () => {
		const { terminal, tui, editor } = await createReadingTui(30);
		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "hello");
		tui.stop();
	});
});
