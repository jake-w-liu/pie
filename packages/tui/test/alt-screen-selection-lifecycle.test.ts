import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("fullscreen selection lifecycle", () => {
	for (const transition of ["overlay", "resize", "key", "non-primary release", "focus-out", "reset"] as const) {
		it(`ends edge auto-scroll on ${transition}`, async (t) => {
			const terminal = new VirtualTerminal(80, 24);
			const copies: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copies.push(text);
					return true;
				},
			});
			t.after(() => tui.stop({ preserveScreen: true }));
			const editor = new Editor(tui, defaultEditorTheme);
			tui.addChild(new Text(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), 0, 0));
			tui.addChild(editor);
			tui.setFocus(editor);
			tui.start();
			await terminal.waitForRender();
			const start = tui.viewportTop;
			terminal.sendInput("\x1b[<0;2;3M");
			terminal.sendInput("\x1b[<32;6;1M");
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.ok(tui.viewportTop < start, "gesture must start auto-scrolling before cancellation");

			if (transition === "overlay") tui.showOverlay(new Text("dialog", 0, 0));
			else if (transition === "resize") terminal.resize(100, 24);
			else if (transition === "key") terminal.sendInput(" ");
			else if (transition === "non-primary release") terminal.sendInput("\x1b[<2;6;1m");
			else if (transition === "reset") tui.requestRender(true);
			else terminal.sendInput("\x1b[O");
			await terminal.waitForRender();
			const stoppedAt = tui.viewportTop;
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(tui.viewportTop, stoppedAt, "cancelled gestures must not retain an auto-scroll timer");
			assert.equal(tui.hasActiveSelection(), false);
			terminal.sendInput("\x1b[<0;6;1m");
			await terminal.waitForRender();
			assert.deepEqual(copies, [], "orphaned release must not copy the cancelled selection");
			assert.equal(editor.getText(), transition === "key" ? " " : "");
		});
	}
});
