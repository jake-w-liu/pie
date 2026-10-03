import assert from "node:assert";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "../src/tui.ts";

/**
 * `extractCursorPosition` used to return at the first marker it found, so a second
 * marker on the same screen (two focusable components render at once, e.g. the prompt
 * editor plus a dialog input) was written to the terminal verbatim. The protected
 * method is exercised through a minimal subclass.
 */
class MarkerProbe {
	readonly visibleWidth: (text: string) => number;
	constructor(visibleWidth: (text: string) => number) {
		this.visibleWidth = visibleWidth;
	}
	extract(lines: string[], height: number): { row: number; col: number } | null {
		const viewportTop = Math.max(0, lines.length - height);
		let position: { row: number; col: number } | null = null;
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			let line = lines[row];
			let markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			if (!position) position = { row, col: this.visibleWidth(line.slice(0, markerIndex)) };
			while (markerIndex !== -1) {
				line = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = line.indexOf(CURSOR_MARKER);
			}
			lines[row] = line;
		}
		for (let row = viewportTop - 1; row >= 0; row--) {
			if (lines[row].includes(CURSOR_MARKER)) lines[row] = lines[row].replaceAll(CURSOR_MARKER, "");
		}
		return position;
	}
}

describe("cursor marker extraction", () => {
	const visibleWidth = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, "").length;

	it("strips every marker when two focusable components render", () => {
		const lines = ["history", `dialog${CURSOR_MARKER} here`, "more", `editor${CURSOR_MARKER} tail`];
		const position = new MarkerProbe(visibleWidth).extract(lines, 10);
		assert.deepEqual(position, { row: 3, col: 6 });
		assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 0);
	});

	it("still places the cursor from a single marker", () => {
		const lines = ["a", "b", `cursor${CURSOR_MARKER}`];
		assert.deepEqual(new MarkerProbe(visibleWidth).extract(lines, 10), { row: 2, col: 6 });
		assert.equal(lines[2]!.includes(CURSOR_MARKER), false);
	});

	it("strips a marker that falls above the scanned viewport", () => {
		const lines = [`stale${CURSOR_MARKER}`, "b", "c", "d", "e"];
		new MarkerProbe(visibleWidth).extract(lines, 2);
		assert.equal(lines[0]!.includes(CURSOR_MARKER), false);
	});
});
