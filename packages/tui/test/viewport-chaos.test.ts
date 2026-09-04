import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Deterministic PRNG so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function transcriptLines(count: number): string {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

describe("Viewport chaos robustness", () => {
	it(
		"never gets stuck after mixed wheel, drag, keys, resize, overlays, and streaming",
		{ timeout: 120000 },
		async () => {
			const terminal = new VirtualTerminal(80, 24);
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

			const rand = mulberry32(1234);
			const pick = (n: number): number => Math.floor(rand() * n);
			let overlay: { hide: () => void } | undefined;
			let transcriptLen = 30;

			const driveToBottom = async (): Promise<void> => {
				for (let i = 0; i < 60; i++) {
					terminal.sendInput("\x1b[<65;40;12M");
					if (i % 10 === 0) await terminal.waitForRender();
				}
				terminal.sendInput("\x1b[B");
				await terminal.waitForRender();
			};

			const assertBottomReachable = async (phase: string): Promise<void> => {
				await driveToBottom();
				const view = (await terminal.flushAndGetViewport()).map((line) => line.trimEnd());
				const dump = `phase=${phase} topRows=${JSON.stringify(view.slice(0, 2))} bottomRows=${JSON.stringify(view.slice(-2))}`;
				assert.ok(
					view.some((line) => line.includes("foot")),
					`stuck: bottom unreachable (${dump})`,
				);
			};

			for (let step = 0; step < 300; step++) {
				const action = pick(100);
				const x = 1 + pick(80);
				const y = 1 + pick(24);
				if (action < 30) {
					// Wheel up/down.
					terminal.sendInput(`\x1b[${action < 15 ? "<64" : "<65"};${x};${y}M`);
				} else if (action < 50) {
					// Press, maybe with motion burst, then release.
					terminal.sendInput(`\x1b[<0;${x};${y}M`);
					const moves = pick(5);
					for (let m = 0; m < moves; m++) {
						terminal.sendInput(`\x1b[<32;${1 + pick(80)};${1 + pick(24)}M`);
					}
					terminal.sendInput(`\x1b[<0;${1 + pick(80)};${1 + pick(24)}m`);
				} else if (action < 60) {
					// Keyboard: Down / PageUp / PageDown / Escape / typing.
					const keys = ["\x1b[B", "\x1b[5~", "\x1b[6~", "\x1b", "q", "\r"];
					terminal.sendInput(keys[pick(keys.length)]!);
				} else if (action < 70) {
					// Streaming growth.
					transcriptLen += 1 + pick(4);
					transcript.setText(transcriptLines(transcriptLen));
					tui.requestRender();
				} else if (action < 75) {
					// Resize away and back.
					terminal.resize(80, 30);
					await terminal.waitForRender();
					terminal.resize(80, 24);
				} else if (action < 80) {
					// Overlay open/close cycle.
					if (overlay) {
						overlay.hide();
						overlay = undefined;
					} else {
						overlay = tui.showOverlay(new Text("dialog", 0, 0));
					}
				} else if (action < 85) {
					// Clicks (press+release same cell).
					terminal.sendInput(`\x1b[<0;${x};${y}M`);
					terminal.sendInput(`\x1b[<0;${x};${y}m`);
				} else if (action < 90) {
					// Double/triple click rhythms.
					terminal.sendInput(`\x1b[<0;${x};${y}M`);
					terminal.sendInput(`\x1b[<0;${x};${y}m`);
					terminal.sendInput(`\x1b[<0;${x};${y}M`);
					terminal.sendInput(`\x1b[<0;${x};${y}m`);
				} else {
					await terminal.waitForRender();
				}

				if (step % 50 === 49) {
					if (overlay) {
						overlay.hide();
						overlay = undefined;
					}
					await assertBottomReachable(`step-${step}`);
				}
			}

			if (overlay) {
				overlay.hide();
				overlay = undefined;
			}
			await assertBottomReachable("final");
			// Editor still functional.
			assert.ok(typeof editor.getText() === "string");
			tui.stop();
		},
	);
});
