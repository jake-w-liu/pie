import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { extractSegments, sliceByColumn } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class StaticOverlay implements Component {
	private readonly line: string;

	constructor(line: string) {
		this.line = line;
	}

	render(): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI overlay compositing", () => {
	it("should not leak styles when a trailing reset sits beyond the last visible column (no overlay)", async () => {
		const width = 20;
		const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;

		const terminal = new VirtualTerminal(width, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new StaticLines([baseLine, "INPUT"]));
		tui.start();
		await renderAndFlush(tui, terminal);
		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("should not leak styles when overlay slicing drops trailing SGR resets", async () => {
		const width = 20;
		const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;

		const terminal = new VirtualTerminal(width, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new StaticLines([baseLine, "INPUT"]));

		tui.showOverlay(new StaticOverlay("OVR"), { row: 0, col: 5, width: 3 });
		tui.start();
		await renderAndFlush(tui, terminal);

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});
});

describe("slice style-reset boundaries", () => {
	it("preserves a reset exactly at the slice end", () => {
		assert.strictEqual(sliceByColumn("\x1b[31mhello\x1b[0m", 0, 5, true), "\x1b[31mhello\x1b[0m");
		assert.strictEqual(sliceByColumn("\x1b[31mhello\x1b[39m", 0, 5, true), "\x1b[31mhello\x1b[39m");
		assert.strictEqual(
			sliceByColumn("\x1b]8;;http://x\x07link\x1b]8;;\x07", 0, 4, true),
			"\x1b]8;;http://x\x07link\x1b]8;;\x07",
		);
	});

	it("still drops opening sequences at the slice end", () => {
		assert.strictEqual(sliceByColumn("hello\x1b[32mworld", 0, 5, true), "hello");
	});

	it("a reset clears opens seen before the slice starts", () => {
		assert.strictEqual(sliceByColumn("\x1b[31mab\x1b[0mcd", 2, 2, true), "\x1b[0mcd");
	});

	it("closes the after segment at its end", () => {
		const segments = extractSegments("\x1b[31mHelloWorld\x1b[0m!!", 0, 0, 5);
		assert.strictEqual(segments.after, "\x1b[31mHello\x1b[0m");
	});
});
