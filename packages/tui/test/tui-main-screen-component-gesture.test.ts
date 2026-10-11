import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const press = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
const release = (x: number, y: number) => `\x1b[<0;${x};${y}m`;

type Invalidation = "resize" | "overlay" | "right-release" | "focus-out";

describe("TuiMainScreen component mouse gestures", () => {
	for (const invalidation of ["resize", "overlay", "right-release", "focus-out"] as const) {
		it(`cancels a component gesture on ${invalidation}`, async () => {
			const terminal = new VirtualTerminal(40, 12);
			const tui = new TuiMainScreen(terminal);
			const transcriptText = Array.from({ length: 6 }, (_, i) => `transcript line ${i + 1}`).join("\n");
			const transcript = new Text(transcriptText, 0, 0);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("hello world editor text");
			tui.addChild(transcript);
			tui.addChild(editor);
			tui.setFocus(editor);
			tui.start();
			try {
				await terminal.waitForRender();
				const screen = (await terminal.flushAndGetViewport()).map((line) => line.trimEnd());
				const editorRow = screen.findIndex((line) => line.startsWith("hello world")) + 1;
				const transcriptRow = screen.findIndex((line) => line.startsWith("transcript line 2")) + 1;
				assert.ok(editorRow > 0 && transcriptRow > 0);

				terminal.sendInput(press(1, editorRow));
				terminal.sendInput(drag(6, editorRow));
				invalidate(invalidation, tui, terminal, editorRow);
				await terminal.waitForRender();

				terminal.sendInput(press(1, transcriptRow));
				terminal.sendInput(drag(12, transcriptRow));
				terminal.sendInput(release(12, transcriptRow));
				await terminal.waitForRender();

				const state = tui as unknown as {
					pendingDrag?: unknown;
					selectionAnchor?: unknown;
					componentMouseGesture?: unknown;
				};
				assert.notEqual(state.selectionAnchor, undefined);
				assert.equal(state.pendingDrag, undefined);
				assert.equal(state.componentMouseGesture, undefined);

				transcript.setText(`${transcriptText}\nNEW STREAMED LINE`);
				tui.requestRender();
				await terminal.waitForRender();
				const after = (await terminal.flushAndGetViewport()).map((line) => line.trimEnd());
				assert.ok(after.some((line) => line.includes("NEW STREAMED LINE")));
			} finally {
				tui.stop();
			}
		});
	}
});

function invalidate(kind: Invalidation, tui: TuiMainScreen, terminal: VirtualTerminal, editorRow: number): void {
	if (kind === "resize") {
		terminal.resize(41, 12);
		terminal.sendInput(release(6, editorRow));
	} else if (kind === "overlay") {
		const overlay = tui.showOverlay(new Text("overlay", 0, 0));
		terminal.sendInput(release(6, editorRow));
		overlay.hide();
	} else if (kind === "right-release") {
		terminal.sendInput(`\x1b[<2;6;${editorRow}m`);
	} else {
		terminal.sendInput("\x1b[O");
	}
}
