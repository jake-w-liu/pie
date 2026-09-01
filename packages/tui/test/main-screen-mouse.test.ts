import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const theme = (text: string) => text;

class RecordingTerminal extends VirtualTerminal {
	readonly events: Array<{ type: "write"; data: string }> = [];

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}
}

describe("TuiMainScreen mouse click-to-position", () => {
	it("enables mouse capture only when a click target is wired", async () => {
		const terminal = new RecordingTerminal(30, 6);
		let editorBox = new VStack([]);
		const tui = new TuiMainScreen(terminal, false, undefined, {
			getClickTarget: () => editorBox,
			onClickTargetPress: (_c, x, y, w) => editorOf(editorBox).positionCursorAtScreen(x, y, w),
		});
		const editor = new Editor(tui, { borderColor: theme, selectList: {} as never });
		editor.setText("hello");
		editorBox = new VStack([editor]);
		tui.addChild(editorBox);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 60));

		const writes = terminal.events.filter((e) => e.type === "write").map((e) => e.data);
		assert.ok(
			writes.some((w) => w.includes("\x1b[?1000h")),
			"should enable button tracking",
		);
		assert.ok(
			writes.some((w) => w.includes("\x1b[?1006h")),
			"should enable SGR encoding",
		);

		tui.stop();
	});

	it("does not enable mouse capture without a click target", async () => {
		const terminal = new RecordingTerminal(30, 6);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new VStack([new Editor(tui, { borderColor: theme, selectList: {} as never })]));
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 60));

		const writes = terminal.events.filter((e) => e.type === "write").map((e) => e.data);
		assert.ok(
			writes.every((w) => !w.includes("\x1b[?1006h")),
			"should not enable mouse without a click target",
		);

		tui.stop();
	});
	it("routes a primary-button press inside the editor to position the cursor", async () => {
		const terminal = new VirtualTerminal(30, 6);
		// Create the TUI first, then the editor so the editor holds the real renderer.
		let editorBox = new VStack([]);
		const tui = new TuiMainScreen(terminal, false, undefined, {
			getClickTarget: () => editorBox,
			onClickTargetPress: (_component, boxX, boxY, boxWidth) => {
				editorOf(editorBox).positionCursorAtScreen(boxX, boxY, boxWidth);
			},
		});
		const editor = new Editor(tui, { borderColor: theme, selectList: {} as never });
		editor.setText("hello world");
		editorBox = new VStack([editor]);
		tui.addChild(new VStack([new Text("line1\nline2\nline3\n", 0, 0)]));
		tui.addChild(editorBox);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 80));

		// Editor content row is viewport row 4 (1-based y=5). Click col 1 -> col 1.
		terminal.sendInput("\x1b[<0;2;5M");
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.deepStrictEqual(editorOf(editorBox).getCursor(), { line: 0, col: 1 });
		tui.stop();
	});

	it("drag-selects a range and returns it on release", async () => {
		const terminal = new VirtualTerminal(30, 6);
		let editorBox = new VStack([]);
		const tui = new TuiMainScreen(terminal, false, undefined, {
			getClickTarget: () => editorBox,
			onClickTargetPress: (_component, boxX, boxY, boxWidth) => {
				editorOf(editorBox).beginMouseSelection(boxX, boxY, boxWidth);
			},
			onClickTargetDrag: (_component, boxX, boxY, boxWidth) => {
				editorOf(editorBox).extendMouseSelection(boxX, boxY, boxWidth);
			},
			onClickTargetRelease: () => editorOf(editorBox).endMouseSelection(),
		});
		const editor = new Editor(tui, { borderColor: theme, selectList: {} as never });
		editor.setText("hello world");
		editorBox = new VStack([editor]);
		tui.addChild(new VStack([new Text("line1\nline2\nline3\n", 0, 0)]));
		tui.addChild(editorBox);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 80));

		// Press at col 0, drag to col 5, release -> "hello".
		terminal.sendInput("\x1b[<0;1;5M");
		await new Promise((resolve) => setTimeout(resolve, 80));
		terminal.sendInput("\x1b[<32;6;5M");
		await new Promise((resolve) => setTimeout(resolve, 80));
		terminal.sendInput("\x1b[<0;6;5m");
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.strictEqual(editorOf(editorBox).getSelectedText(), "hello");
		tui.stop();
	});

	it("does not route clicks outside the editor region", async () => {
		const terminal = new VirtualTerminal(30, 6);
		let editorBox = new VStack([]);
		let pressCount = 0;
		const tui = new TuiMainScreen(terminal, false, undefined, {
			getClickTarget: () => editorBox,
			onClickTargetPress: (_component, boxX, boxY, boxWidth) => {
				pressCount += 1;
				editorOf(editorBox).positionCursorAtScreen(boxX, boxY, boxWidth);
			},
		});
		const editor = new Editor(tui, { borderColor: theme, selectList: {} as never });
		editor.setText("hello");
		editorBox = new VStack([editor]);
		tui.addChild(new VStack([new Text("line1\nline2\nline3\n", 0, 0)]));
		tui.addChild(editorBox);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 80));

		// Click in the transcript region (row 2) - far above the editor.
		terminal.sendInput("\x1b[<0;10;2M");
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.strictEqual(pressCount, 0);
		tui.stop();
	});
});

/** Pull the Editor out of an editor box's first child. */
function editorOf(box: VStack): Editor {
	return box.children[0] as Editor;
}
