import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("StdinBuffer interrupted sequence recovery", () => {
	for (const next of ["\x1b[<0;6;2m", "\x1b[O", "\x1b[47u", "\x1b[A"]) {
		it(`resynchronizes a truncated mouse report before ${JSON.stringify(next)}`, (t) => {
			const buffer = new StdinBuffer();
			t.after(() => buffer.destroy());
			const received: string[] = [];
			buffer.on("data", (data) => received.push(data));
			buffer.process("\x1b[<0;3;");
			buffer.process(next);
			assert.deepEqual(received, [next]);
			assert.equal(buffer.getBuffer(), "");
		});
	}

	it("keeps recovery bounded during a burst of interrupted mouse reports", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const received: string[] = [];
		buffer.on("data", (data) => received.push(data));
		for (let index = 0; index < 1000; index++) {
			buffer.process("\x1b[<32;3;");
			assert.equal(buffer.getBuffer(), "\x1b[<32;3;");
		}
		buffer.process("\x1b[<0;6;2m");
		assert.deepEqual(received, ["\x1b[<0;6;2m"]);
		assert.equal(buffer.getBuffer(), "");
	});

	it("still reassembles valid mouse reports at every byte boundary", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const received: string[] = [];
		buffer.on("data", (data) => received.push(data));
		const sequence = "\x1b[<0;6;2m";
		for (let split = 1; split < sequence.length; split++) {
			buffer.process(sequence.slice(0, split));
			buffer.process(sequence.slice(split));
		}
		assert.deepEqual(
			received,
			Array.from({ length: sequence.length - 1 }, () => sequence),
		);
		assert.equal(buffer.getBuffer(), "");
	});

	for (const sequence of ["\x1b]11;rgb:00/00/00\x1b\\", "\x1bP>|terminal version\x1b\\", "\x1b_Gi=1;OK\x1b\\"]) {
		it(`preserves all chunk boundaries in ${JSON.stringify(sequence)}`, (t) => {
			const buffer = new StdinBuffer();
			t.after(() => buffer.destroy());
			const received: string[] = [];
			buffer.on("data", (data) => received.push(data));
			for (let split = 1; split < sequence.length; split++) {
				buffer.process(sequence.slice(0, split));
				buffer.process(sequence.slice(split));
			}
			assert.deepEqual(
				received,
				Array.from({ length: sequence.length - 1 }, () => sequence),
			);
			assert.equal(buffer.getBuffer(), "");
		});
	}

	it("does not split string-terminated replies or bracketed paste", (t) => {
		const buffer = new StdinBuffer();
		t.after(() => buffer.destroy());
		const received: string[] = [];
		const pastes: string[] = [];
		buffer.on("data", (data) => received.push(data));
		buffer.on("paste", (data) => pastes.push(data));
		buffer.process("\x1b]11;rgb:00/00/00\x1b");
		buffer.process("\\");
		buffer.process("\x1b[200~\x1b[<0;3;\x1b[O\x1b[201~");
		assert.deepEqual(received, ["\x1b]11;rgb:00/00/00\x1b\\"]);
		assert.deepEqual(pastes, ["\x1b[<0;3;\x1b[O"]);
	});
});
