/**
 * Regression tests for TUI security/robustness audit fixes:
 * - OSC 8 hyperlink injection via raw URL/text (terminal-image.ts hyperlink)
 * - Markdown render() with non-positive width (RangeError via repeat)
 * - Markdown render() returning a live cached array
 * - calculateImageCellSize with zero cell dimensions (NaN)
 * - imageFallback with unsanitized filename display text
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import {
	calculateImageCellSize,
	hyperlink,
	imageFallback,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/** Extract the URL payload between the OSC 8 opener and its ST terminator. */
function extractOsc8Url(sequence: string): string {
	const open = "\x1b]8;;";
	const st = "\x1b\\";
	const start = sequence.indexOf(open);
	assert.ok(start !== -1, "missing OSC 8 opener");
	const payloadStart = start + open.length;
	const end = sequence.indexOf(st, payloadStart);
	assert.ok(end !== -1, "missing OSC 8 terminator");
	return sequence.slice(payloadStart, end);
}

function countEsc(sequence: string): number {
	return sequence.split("\x1b").length - 1;
}

describe("OSC 8 hyperlink sanitization", () => {
	it("strips ESC breakout from the URL (audit repro)", () => {
		const result = hyperlink("t", "http://x\x1b[2J");
		// The framing itself uses exactly 4 ESC bytes (open, ST, close, ST).
		assert.strictEqual(countEsc(result), 4);
		assert.strictEqual(extractOsc8Url(result), "http://x[2J");
	});

	it("strips BEL and ST bytes from the URL", () => {
		const result = hyperlink("t", "https://example.com/a\x07b\x9cc");
		assert.strictEqual(extractOsc8Url(result), "https://example.com/abc");
		assert.ok(!result.includes("\x07"), "no BEL in output");
		assert.ok(!result.includes("\x9c"), "no ST byte in output");
	});

	it("preserves SGR styling in display text but strips injected CSI/OSC", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const clean = hyperlink(styled, "https://example.com");
		assert.ok(clean.includes(styled), "SGR styling must survive");

		const evil = hyperlink(`a\x1b[2Jb\x1b]0;evil\x07c`, "https://example.com");
		assert.ok(!evil.includes("\x1b[2J"), "CSI erase must be stripped from text");
		assert.ok(!evil.includes("\x1b]0;evil"), "injected OSC must be stripped from text");
		assert.ok(evil.includes("abc"), "benign text content must survive");
	});

	it("plain URLs and text round-trip unchanged", () => {
		assert.strictEqual(
			hyperlink("click me", "https://example.com"),
			"\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\",
		);
	});
});

describe("imageFallback filename sanitization", () => {
	it("strips escape sequences from the display text (hyperlinks on)", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const out = imageFallback("image/png", { widthPx: 8, heightPx: 6 }, "/tmp/evil\x1b[2Jfile.png");
			assert.ok(!out.includes("\x1b[2J"), "injected CSI must not survive");
			assert.ok(!out.includes("evil\x1b"), "no raw ESC near filename");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("strips escape sequences from the display text (hyperlinks off)", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const out = imageFallback("image/png", { widthPx: 8, heightPx: 6 }, "/tmp/evil\x1b[2Jfile.png");
			assert.ok(!out.includes("\x1b"), "no ESC at all when hyperlinks are off");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("Markdown render() width clamping", () => {
	for (const width of [0, -1, -80]) {
		it(`does not throw for width ${width}`, () => {
			const markdown = new Markdown("# hi", 0, 0, defaultMarkdownTheme);
			assert.doesNotThrow(() => markdown.render(width));
			const lines = markdown.render(width);
			assert.ok(Array.isArray(lines));
		});
	}
});

describe("Markdown render() cache isolation", () => {
	it("returns a copy so caller mutation does not corrupt the cache", () => {
		const markdown = new Markdown("# hello", 0, 0, defaultMarkdownTheme);
		const first = markdown.render(80);
		first.push("MUTATED");
		first[0] = "MUTATED";
		const second = markdown.render(80);
		assert.ok(!second.includes("MUTATED"), "cache must be immune to caller mutation");
		assert.notStrictEqual(first, second);
	});
});

describe("calculateImageCellSize zero cell dimensions", () => {
	it("clamps zero cell dimensions instead of producing NaN", () => {
		const size = calculateImageCellSize({ widthPx: 100, heightPx: 100 }, 10, 10, { widthPx: 0, heightPx: 0 });
		assert.ok(Number.isFinite(size.columns), "columns must be finite");
		assert.ok(Number.isFinite(size.rows), "rows must be finite");
		assert.ok(size.columns >= 1 && size.rows >= 1, "cell size must be at least 1x1");
	});
});
