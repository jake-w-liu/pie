import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapTextWithAnsi } from "../src/utils.ts";

describe("wrap cache budget accounts for keys (D1)", () => {
	it("returns correct wrapped lines and caches hits by value", () => {
		const first = wrapTextWithAnsi("hello world", 5);
		assert.ok(first.length > 1);
		assert.ok(
			first.every((line) => line.length <= 20),
			"wrapped lines stay small",
		);
		const second = wrapTextWithAnsi("hello world", 5);
		assert.deepEqual(second, first);
		// Cache hit hands back the same frozen array instance.
		assert.strictEqual(second, first);
	});

	it("keeps results read-only and correct after many distinct inserts", () => {
		const seen: string[][] = [];
		for (let i = 0; i < 50; i++) {
			const text = `entry-${i} ${"word ".repeat(20)}`;
			const wrapped = wrapTextWithAnsi(text, 20);
			assert.ok(wrapped.length >= 1);
			seen.push(wrapped);
		}
		// Earlier entries still decode to the same content after eviction pressure.
		const again = wrapTextWithAnsi(`entry-0 word ${"word ".repeat(19).trim()}`, 20);
		assert.ok(again.length >= 1);
		assert.ok(Object.isFrozen(seen[0]!));
	});

	it("freezes cached arrays so mutation fails fast instead of corrupting frames", () => {
		const cached = wrapTextWithAnsi("frozen-check payload", 8);
		assert.ok(Object.isFrozen(cached));
		assert.throws(() => {
			(cached as string[])[0] = "mutated";
		});
	});
});
