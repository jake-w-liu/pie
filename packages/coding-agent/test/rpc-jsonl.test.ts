import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("scans a record split across many chunks in linear time", () => {
		const record = serializeJsonLine({ type: "prompt", message: "x".repeat(1024 * 1024) });
		const chunkSize = 1024;
		const stream = new EventEmitter();
		const lines: string[] = [];
		attachJsonlLineReader(stream as Readable, (line) => {
			lines.push(line);
		});

		// Count the characters LF searches cover. Rescanning the buffered prefix on every chunk
		// makes this grow with the square of the record length.
		const originalIndexOf = String.prototype.indexOf;
		let scanned = 0;
		String.prototype.indexOf = function (this: string, searchString: string, position?: number): number {
			scanned += this.length - Math.min(this.length, Math.max(0, position ?? 0));
			return originalIndexOf.call(this, searchString, position);
		};
		try {
			for (let offset = 0; offset < record.length; offset += chunkSize) {
				stream.emit("data", Buffer.from(record.slice(offset, offset + chunkSize)));
			}
		} finally {
			String.prototype.indexOf = originalIndexOf;
		}
		stream.emit("end");

		expect(lines).toEqual([record.slice(0, -1)]);
		expect(scanned).toBeLessThanOrEqual(2 * record.length);
	});
});
