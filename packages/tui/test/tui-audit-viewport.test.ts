import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const rows = (count: number) => new Text(Array.from({ length: count }, (_, i) => `row ${i}`).join("\n"), 0, 0);

describe("audit viewport input ownership", () => {
	for (const custom of [false, true]) {
		it(`ignores release phases without swallowing opted-in input (custom=${custom})`, () => {
			const previous = getKeybindings();
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TuiMainScreen(terminal);
			const inputs: string[] = [];
			const raw: string[] = [];
			const focused = {
				render: () => [],
				invalidate: () => {},
				wantsKeyRelease: true,
				handleInput: (data: string) => inputs.push(data),
			};
			try {
				setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, custom ? { "tui.editor.pageUp": "ctrl+p" } : {}));
				tui.addChild(rows(100));
				tui.addChild(focused);
				tui.setFocus(focused);
				tui.addInputListener((data) => {
					raw.push(data);
					return undefined;
				});
				tui.start();
				tui.renderNow();
				const press = custom ? "\x1b[112;5:1u" : "\x1b[5;1:1~";
				const repeat = custom ? "\x1b[112;5:2u" : "\x1b[5;1:2~";
				const release = custom ? "\x1b[112;5:3u" : "\x1b[5;1:3~";
				terminal.sendInput(press);
				assert.equal(tui.captureRenderState().previousViewportTop, 53);
				terminal.sendInput(release);
				assert.equal(tui.captureRenderState().previousViewportTop, 53);
				terminal.sendInput("\x1b[97;1:3u");
				assert.equal(tui.captureRenderState().previousViewportTop, 53);
				terminal.sendInput(repeat);
				assert.equal(tui.captureRenderState().previousViewportTop, 30);
				assert.deepEqual(inputs, [release, "\x1b[97;1:3u"]);
				assert.deepEqual(raw, [press, release, "\x1b[97;1:3u", repeat]);
				focused.wantsKeyRelease = false;
				terminal.sendInput(release);
				assert.equal(inputs.length, 2);
				terminal.sendInput("a");
				assert.equal(tui.captureRenderState().previousViewportTop, 76);
			} finally {
				tui.stop();
				setKeybindings(previous);
			}
		});
	}

	for (const nested of [false, true]) {
		for (const direction of [-1, 1]) {
			for (const partial of [false, true]) {
				it(`contains ${nested ? "nested" : "sibling"} wheel delta direction=${direction} partial=${partial}`, () => {
					const terminal = new VirtualTerminal(40, 4);
					const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
					const primary = new ScrollView(rows(20), { primary: true });
					const contained = new ScrollView(rows(10), { overscroll: "contain" });
					const outer = new ScrollView(new VStack([{ component: contained, basis: 2 }, rows(10)]));
					const pane = nested ? outer : contained;
					tui.setLayoutRoot(
						new HStack([
							{ component: primary, basis: 20 },
							{ component: pane, basis: 20 },
						]),
					);
					try {
						tui.start();
						tui.renderNow();
						primary.scrollTo(5);
						const maxTop = 10 - contained.viewportHeight;
						contained.scrollTo(direction < 0 ? (partial ? 1 : 0) : maxTop - (partial ? 1 : 0));
						tui.renderNow();
						terminal.sendInput(`\x1b[<${direction < 0 ? 64 : 65};21;1M`);
						assert.equal(contained.scrollTop, direction < 0 ? 0 : maxTop);
						assert.equal(primary.scrollTop, 5);
						assert.equal(outer.scrollTop, 0);
					} finally {
						tui.stop();
					}
				});
			}
		}
	}

	it("retains default chaining and primary fallback over non-scrollable docks", () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const primary = new ScrollView(rows(20), { primary: true });
		const sibling = new ScrollView(rows(10));
		tui.setLayoutRoot(
			new VStack([
				{
					component: new HStack([
						{ component: primary, basis: 20 },
						{ component: sibling, basis: 20 },
					]),
					basis: 3,
				},
				{ component: new Text("dock", 0, 0), basis: 1 },
			]),
		);
		try {
			tui.start();
			tui.renderNow();
			primary.scrollTo(5);
			sibling.scrollTo(1);
			tui.renderNow();
			terminal.sendInput("\x1b[<64;21;1M");
			assert.equal(sibling.scrollTop, 0);
			assert.equal(primary.scrollTop, 3);
			tui.renderNow();
			terminal.sendInput("\x1b[<65;1;4M");
			assert.equal(primary.scrollTop, 6);
		} finally {
			tui.stop();
		}
	});
});
