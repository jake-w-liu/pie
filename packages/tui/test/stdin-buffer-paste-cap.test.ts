import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("StdinBuffer bracketed-paste cap (A6)", () => {
	it("emits a normal paste unchanged", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const pastes: string[] = [];
		buffer.on("paste", (data) => pastes.push(data));
		buffer.process(`${PASTE_START}hello${PASTE_END}`);
		assert.deepEqual(pastes, ["hello"]);
	});

	it("bounds memory when the terminator never arrives", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const pastes: string[] = [];
		buffer.on("paste", (data) => pastes.push(data));
		buffer.process(PASTE_START);
		// ~2MB without a terminator: must not accumulate unboundedly.
		for (let i = 0; i < 200; i++) buffer.process("x".repeat(10_000));
		assert.equal(pastes.length, 0);
		const internals = buffer as unknown as { pasteBuffer: string; pasteTruncated: boolean };
		assert.ok(internals.pasteBuffer.length <= 1_000_000 + 10);
		assert.equal(internals.pasteTruncated, true);
	});

	it("resynchronizes and emits truncated content once the terminator arrives", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const pastes: string[] = [];
		const received: string[] = [];
		buffer.on("paste", (data) => pastes.push(data));
		buffer.on("data", (data) => received.push(data));
		buffer.process(PASTE_START);
		for (let i = 0; i < 120; i++) buffer.process("y".repeat(10_000));
		assert.equal(pastes.length, 0);
		buffer.process(`tail${PASTE_END}`);
		assert.equal(pastes.length, 1);
		assert.ok(pastes[0]!.length <= 1_000_000);
		assert.ok(pastes[0]!.startsWith("y"));
		// Stream resynchronizes: data after the paste is processed normally.
		buffer.process("z");
		assert.deepEqual(received, ["z"]);
	});

	it("truncates a single over-cap paste delivered in one chunk", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const pastes: string[] = [];
		buffer.on("paste", (data) => pastes.push(data));
		buffer.process(`${PASTE_START}${"q".repeat(1_200_000)}${PASTE_END}`);
		assert.equal(pastes.length, 1);
		assert.equal(pastes[0]!.length, 1_000_000);
	});
});
