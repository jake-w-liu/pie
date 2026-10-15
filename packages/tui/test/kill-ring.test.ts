import assert from "node:assert";
import { describe, it } from "node:test";
import { KillRing } from "../src/kill-ring.ts";

describe("KillRing", () => {
	it("retains a bounded number of entries, dropping the oldest", () => {
		const ring = new KillRing();
		for (let i = 0; i < 1000; i++) {
			ring.push(`kill ${i}`, { prepend: false });
		}

		assert.strictEqual(ring.length, 10);
		// Yank-pop cycles through the newest entries only.
		const cycled: string[] = [];
		for (let i = 0; i < ring.length; i++) {
			cycled.push(ring.peek() ?? "");
			ring.rotate();
		}
		assert.deepStrictEqual(
			cycled,
			Array.from({ length: 10 }, (_, i) => `kill ${999 - i}`),
		);
	});

	it("accumulates consecutive kills into the newest entry", () => {
		const ring = new KillRing();
		for (let i = 0; i < 20; i++) {
			ring.push(`${i}`, { prepend: false, accumulate: i > 0 });
		}

		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), Array.from({ length: 20 }, (_, i) => `${i}`).join(""));
	});
});
