import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

/** Minimal APNG: PNG signature, IHDR, acTL animation control chunk. */
const APNG_HEAD = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from([0x00, 0x00, 0x00, 0x0d]),
	Buffer.from("IHDR"),
	Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
	Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
	Buffer.from([0x00, 0x00, 0x00, 0x08]),
	Buffer.from("acTL"),
	Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]),
	Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "read-guard-"));
	await writeFile(join(dir, "notes.txt"), "line one\nline two\n");
	await writeFile(join(dir, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>');
	await writeFile(join(dir, "archive.zip"), "PK\u0003\u0004 not really text");
	await writeFile(join(dir, "ARCHIVE.ZIP"), "uppercase extension");
	await writeFile(join(dir, "corrupt.txt"), Buffer.from([0x61, 0x00, 0x62, 0x0a, 0x63]));
	await writeFile(join(dir, "utf16.txt"), Buffer.from("\ufeffhello\nworld\n", "utf16le"));
	await writeFile(join(dir, "animation.png"), APNG_HEAD);
	await writeFile(join(dir, "scan.dat"), Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]));
	await writeFile(join(dir, "photo.jpg"), TINY_PNG);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("read tool rejects files it cannot read as text", () => {
	it("still reads text files", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("call-1", { path: "notes.txt" });
		expect(result.content).toEqual([{ type: "text", text: "line one\nline two" }]);
	});

	it("still reads SVG source as text", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("call-2", { path: "diagram.svg" });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("<svg");
	});

	it("still sends images to the model", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("call-3", { path: "photo.jpg" });
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	it("rejects known binary extensions without reading content", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-4", { path: "archive.zip" })).rejects.toThrow(/\.zip files are binary/);
		await expect(read.execute("call-5", { path: "ARCHIVE.ZIP" })).rejects.toThrow(/\.zip files are binary/);
	});

	it("rejects NUL bytes in a text-named file", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-6", { path: "corrupt.txt" })).rejects.toThrow(/NUL bytes/);
	});

	it("rejects UTF-16 encoded files with conversion guidance", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-7", { path: "utf16.txt" })).rejects.toThrow(/UTF-16LE/);
	});

	it("rejects animated PNGs", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-8", { path: "animation.png" })).rejects.toThrow(/animated PNG/);
	});

	it("rejects unsupported image formats detected from content", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-9", { path: "scan.dat" })).rejects.toThrow(/TIFF/);
	});

	it("rejects device files that never reach EOF", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-10", { path: "/dev/zero" })).rejects.toThrow(/device file/);
	});

	it("still reports missing files as missing", async () => {
		const read = createReadTool(dir);
		await expect(read.execute("call-11", { path: "nope.zip" })).rejects.toThrow(/ENOENT|no such file/i);
	});

	it("rejects directories with a pointer to ls", async () => {
		const read = createReadTool(dir);
		await mkdir(join(dir, "nested"), { recursive: true });
		await expect(read.execute("call-12", { path: "nested" })).rejects.toThrow(/is a directory/);
	});

	it.skipIf(process.platform === "win32")(
		"rejects special files such as FIFOs instead of blocking on them",
		async () => {
			const fifo = join(dir, "events.fifo");
			execFileSync("mkfifo", [fifo]);
			const read = createReadTool(dir);
			// A regression would block on open(); the timeout keeps the failure fast.
			await expect(read.execute("call-13", { path: "events.fifo" }, AbortSignal.timeout(5_000))).rejects.toThrow(
				/special file/,
			);
		},
	);

	it("still reads /dev/null as an empty file", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("call-14", { path: "/dev/null" });
		expect((result.content[0] as { text: string }).text).toBe("");
	});
});
