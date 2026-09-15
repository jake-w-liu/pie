import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("over-wide line crash-log throttle (A4)", () => {
	it("logs the first identical report once, then throttles repeats", () => {
		const terminal = new VirtualTerminal(80, 24);
		const screen = new TuiMainScreen(terminal);
		try {
			const inner = screen as unknown as {
				shouldLogOverwideLine(width: number, lineWidth: number, line: string): boolean;
			};
			const line = "x".repeat(100);
			assert.equal(inner.shouldLogOverwideLine(80, 100, line), true);
			// Same width/content within the throttle window: suppressed.
			assert.equal(inner.shouldLogOverwideLine(80, 100, line), false);
			assert.equal(inner.shouldLogOverwideLine(80, 100, line), false);
			// Distinct content still logs immediately.
			assert.equal(inner.shouldLogOverwideLine(80, 100, `${line}y`), true);
		} finally {
			screen.stop();
		}
	});

	it("re-logs an identical report after the throttle window elapses", () => {
		const terminal = new VirtualTerminal(80, 24);
		const screen = new TuiMainScreen(terminal);
		try {
			const inner = screen as unknown as {
				shouldLogOverwideLine(width: number, lineWidth: number, line: string): boolean;
				lastOverwideLogAt: number;
			};
			const line = "z".repeat(100);
			assert.equal(inner.shouldLogOverwideLine(80, 100, line), true);
			assert.equal(inner.shouldLogOverwideLine(80, 100, line), false);
			// Simulate the 60s window passing.
			inner.lastOverwideLogAt -= 61_000;
			assert.equal(inner.shouldLogOverwideLine(80, 100, line), true);
		} finally {
			screen.stop();
		}
	});
});
