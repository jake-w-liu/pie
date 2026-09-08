import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Container } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function panel(label: string) {
	const inputs: string[] = [];
	return {
		focused: false,
		inputs,
		render: () => [label],
		invalidate() {},
		handleInput(data: string) {
			inputs.push(data);
		},
	};
}

describe("focus-reference replacement ownership", () => {
	const active: TuiMainScreen[] = [];
	afterEach(() => {
		for (const tui of active.splice(0)) tui.stop();
	});
	function setup() {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const base = new Container();
		const previous = panel("previous");
		const replacement = panel("replacement");
		base.addChild(previous);
		tui.addChild(base);
		tui.setFocus(previous);
		tui.start();
		active.push(tui);
		return { tui, terminal, base, previous, replacement };
	}

	for (const toNull of [false, true]) {
		it(`replaces only the departing current focus (null: ${toNull})`, () => {
			const { tui, terminal, base, previous, replacement } = setup();
			base.removeChild(previous);
			if (!toNull) base.addChild(replacement);
			tui.replaceFocus(previous, toNull ? null : replacement);
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), toNull ? null : replacement);
			assert.equal(previous.focused, false);
			assert.deepEqual(previous.inputs, []);
			assert.deepEqual(replacement.inputs, toNull ? [] : ["x"]);
		});
	}

	it("retains an unrelated mounted base target without creating an overlay lease", () => {
		const { tui, terminal, base, previous, replacement } = setup();
		const other = panel("unrelated");
		base.addChild(other);
		tui.setFocus(other);
		base.removeChild(previous);
		base.addChild(replacement);
		tui.replaceFocus(previous, replacement);
		terminal.sendInput("x");
		assert.equal(tui.getFocusedComponent(), other);
		assert.deepEqual(other.inputs, ["x"]);
		assert.deepEqual(previous.inputs, []);
		assert.deepEqual(replacement.inputs, []);
	});

	for (const hidden of [false, true]) {
		it(`retargets a passive overlay fallback even while hidden (${hidden})`, () => {
			const { tui, terminal, base, previous, replacement } = setup();
			const overlay = panel("passive");
			const handle = tui.showOverlay(overlay, { nonCapturing: true });
			handle.setHidden(hidden);
			base.removeChild(previous);
			base.addChild(replacement);
			tui.replaceFocus(previous, replacement);
			handle.setHidden(false);
			handle.focus();
			terminal.sendInput("u");
			handle.hide();
			terminal.sendInput("e");
			assert.deepEqual(overlay.inputs, ["u"]);
			assert.deepEqual(replacement.inputs, ["e"]);
			assert.deepEqual(previous.inputs, []);
		});
	}

	for (const targetIsDeparting of [false, true]) {
		it(`retargets only a departing explicit resume target (${targetIsDeparting})`, () => {
			const { tui, terminal, base, previous, replacement } = setup();
			const blocker = panel("blocker");
			const liveTarget = panel("live explicit target");
			base.addChild(blocker);
			base.addChild(liveTarget);
			const overlay = panel("overlay");
			const handle = tui.showOverlay(overlay);
			tui.setFocus(blocker);
			handle.unfocus({ target: targetIsDeparting ? previous : liveTarget });
			base.removeChild(previous);
			base.addChild(replacement);
			tui.replaceFocus(previous, replacement);
			terminal.sendInput("b");
			assert.deepEqual(blocker.inputs, ["b"]);
			assert.equal(handle.isFocused(), false);
			base.removeChild(blocker);
			tui.setFocus(replacement);
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), targetIsDeparting ? replacement : liveTarget);
			assert.deepEqual(previous.inputs, []);
			assert.deepEqual(overlay.inputs, []);
			handle.hide();
		});
	}

	it("releases a departing mounted blocker through the existing overlay resume policy", () => {
		const { tui, terminal, base, previous, replacement } = setup();
		const blocker = panel("blocker");
		base.addChild(blocker);
		const overlay = panel("overlay");
		const handle = tui.showOverlay(overlay);
		tui.setFocus(blocker);
		terminal.sendInput("b");
		assert.deepEqual(blocker.inputs, ["b"]);
		base.removeChild(blocker);
		base.addChild(replacement);
		tui.replaceFocus(blocker, replacement);
		terminal.sendInput("u");
		assert.equal(handle.isFocused(), true);
		assert.deepEqual(overlay.inputs, ["u"]);
		handle.hide();
		assert.equal(tui.getFocusedComponent(), previous);
	});

	it("permanently removed handles cannot unfocus a reused live component", () => {
		const { tui, terminal, previous } = setup();
		const overlay = panel("reused overlay");
		const retired = tui.showOverlay(overlay);
		retired.hide();
		const current = tui.showOverlay(overlay);
		retired.unfocus({ target: previous });
		assert.equal(current.isFocused(), true);
		assert.equal(retired.isFocused(), false);
		terminal.sendInput("x");
		assert.deepEqual(overlay.inputs, ["x"]);
		assert.deepEqual(previous.inputs, []);
		current.hide();
	});

	it("live capturing handles still hide temporarily and regain focus when shown", () => {
		const { tui, terminal, previous } = setup();
		const overlay = panel("live overlay");
		const handle = tui.showOverlay(overlay);
		handle.setHidden(true);
		terminal.sendInput("e");
		handle.setHidden(false);
		terminal.sendInput("u");
		assert.equal(handle.isFocused(), true);
		assert.deepEqual(previous.inputs, ["e"]);
		assert.deepEqual(overlay.inputs, ["u"]);
		handle.hide();
	});
});
