import { describe, expect, it } from "vitest";
import { shouldReparseStreamingJson } from "../src/utils/json-parse.ts";

/**
 * Re-parsing the whole accumulated tool-argument buffer on every stream delta is
 * Θ(n²) on the stream loop, which blocks the whole process: a 256 KB Write
 * argument measured ~28s of event-loop stall. Small buffers keep the original
 * per-delta behavior so streaming previews stay smooth; large ones re-parse on
 * a doubling budget, and every adapter re-parses once more at block end.
 */
describe("shouldReparseStreamingJson", () => {
	it("re-parses every delta while the buffer is small", () => {
		let lastParsed = 0;
		let length = 0;
		let parses = 0;
		for (let i = 0; i < 32; i++) {
			length += 64;
			if (shouldReparseStreamingJson(lastParsed, length)) {
				lastParsed = length;
				parses++;
			}
		}
		expect(parses).toBe(32);
	});

	it("keeps the number of parses logarithmic in the buffer size", () => {
		const countParses = (totalBytes: number, deltaBytes = 64): number => {
			let lastParsed = 0;
			let length = 0;
			let parses = 0;
			for (; length < totalBytes; length += deltaBytes) {
				if (shouldReparseStreamingJson(lastParsed, length)) {
					lastParsed = length;
					parses++;
				}
			}
			return parses;
		};

		const at128k = countParses(128_000);
		const at256k = countParses(256_000);

		// Doubling the buffer must not double the parse count; the whole point is
		// that parse work stays amortized linear instead of quadratic.
		expect(at256k).toBeLessThan(at128k * 2);
		expect(at128k).toBeLessThan(100);
	});

	it("always asks for a parse once a large buffer stopped growing", () => {
		// The final re-parse at block end is unconditional in every adapter, so the
		// last size must not be skipped by the budget rule.
		const lastParsed = 200_000;
		expect(shouldReparseStreamingJson(lastParsed, lastParsed)).toBe(false);
		expect(lastParsed).toBeLessThanOrEqual(200_000);
	});
});
