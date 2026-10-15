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

	it("evicts the oldest kill after yank-pop, keeping kill order", () => {
		const ring = new KillRing();
		for (const kill of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
			ring.push(kill, { prepend: false });
		}
		ring.rotate(); // yank-pop from "j" to "i"
		assert.strictEqual(ring.peek(), "i");
		ring.push("k", { prepend: false });

		// The new kill is yanked first, then yank-pop visits the earlier kills newest first.
		const cycled: string[] = [];
		for (let i = 0; i < ring.length; i++) {
			cycled.push(ring.peek() ?? "");
			ring.rotate();
		}
		assert.deepStrictEqual(cycled, ["k", "j", "i", "h", "g", "f", "e", "d", "c", "b"]);
		assert.strictEqual(ring.peek(), "k");
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
