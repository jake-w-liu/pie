import assert from "node:assert/strict";
import { wrapTextWithAnsi } from "../../src/utils.ts";

const probe = "cached output must survive oversized entries";
const cached = wrapTextWithAnsi(probe, 20);
for (const [urlLength, lineCount] of [
	[16_000, 300],
	[9_000, 600],
]) {
	const open = `\x1b]8;;https://example.com/${"a".repeat(urlLength)}\x07`;
	const text = open + "x\n".repeat(lineCount);
	assert.ok(text.length < 32 * 1024, "input must qualify for the wrapping cache");
	for (let attempt = 0; attempt < 2; attempt++) {
		const lines = wrapTextWithAnsi(text, 80);
		assert.equal(lines.length, lineCount + 1);
		assert.ok(lines.reduce((total, line) => total + line.length, 0) > 4 * 1024 * 1024);
		for (let index = 0; index < lines.length; index++) {
			assert.equal(lines[index], open + (index < lineCount ? "x" : ""));
		}
		assert.strictEqual(wrapTextWithAnsi(probe, 20), cached);
	}
}

// Two individually cacheable expansions must evict the oldest, not exceed the total budget.
const open = `\x1b]8;;https://example.com/${"b".repeat(12_000)}\x07`;
const firstText = open + "a\n".repeat(200);
const secondText = open + "b\n".repeat(200);
const first = wrapTextWithAnsi(firstText, 80);
const second = wrapTextWithAnsi(secondText, 80);
assert.strictEqual(wrapTextWithAnsi(secondText, 80), second);
const rewrapped = wrapTextWithAnsi(firstText, 80);
assert.notStrictEqual(rewrapped, first);
assert.deepEqual(rewrapped, first);
