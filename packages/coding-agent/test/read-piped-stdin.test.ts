import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPipedStdin } from "../src/utils/stdin.ts";

describe("audit readPipedStdin (L5)", () => {
	it("returns undefined for a TTY without touching the stream", async () => {
		const source = new PassThrough();
		(source as unknown as { isTTY: boolean }).isTTY = true;
		const listenersBefore = source.listenerCount("data");
		await expect(readPipedStdin(source)).resolves.toBeUndefined();
		expect(source.listenerCount("data")).toBe(listenersBefore);
		source.destroy();
	});

	it("joins chunks and removes listeners after end", async () => {
		const source = new PassThrough();
		const pending = readPipedStdin(source);
		source.write("hello ");
		source.write("world");
		source.end();
		await expect(pending).resolves.toBe("hello world");
		expect(source.listenerCount("data")).toBe(0);
		expect(source.listenerCount("end")).toBe(0);
		expect(source.listenerCount("error")).toBe(0);
	});

	it("resolves undefined for blank input", async () => {
		const source = new PassThrough();
		const pending = readPipedStdin(source);
		source.write("   \n");
		source.end();
		await expect(pending).resolves.toBeUndefined();
		expect(source.listenerCount("data")).toBe(0);
	});

	it("resolves undefined and cleans up on stream error", async () => {
		const source = new PassThrough();
		const pending = readPipedStdin(source);
		// Prevent an unhandled 'error' event if the implementation changes.
		source.on("error", () => {});
		source.destroy(new Error("EIO"));
		await expect(pending).resolves.toBeUndefined();
		expect(source.listenerCount("data")).toBe(0);
		expect(source.listenerCount("end")).toBe(0);
		expect(source.listenerCount("error")).toBe(1); // only our test guard
	});
});
