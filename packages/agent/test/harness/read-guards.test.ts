import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import {
	getUnreadableContentReason,
	getUnreadableFileKindReason,
	getUnreadablePathReason,
	isPdfContent,
	isPdfPath,
} from "../../src/harness/tools/text-file.ts";
import { createTempDir } from "./session-test-utils.ts";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

describe("read tool path guards", () => {
	it("rejects device paths that block or never end", () => {
		for (const path of [
			"/dev/zero",
			"/dev/urandom",
			"/dev/stdin",
			"/dev/fd/0",
			"/proc/self/fd/0",
			"/proc/1234/fd/2",
		]) {
			expect(getUnreadablePathReason(path), path).toContain("device file");
		}
	});

	it("rejects known binary extensions but allows text, image, and PDF paths", () => {
		expect(getUnreadablePathReason("/tmp/archive.zip")).toContain("binary");
		expect(getUnreadablePathReason("/tmp/REPORT.DOCX")).toContain("binary");
		expect(getUnreadablePathReason("/tmp/scan.tiff")).toContain("binary");
		expect(getUnreadablePathReason("/tmp/notes.txt")).toBeUndefined();
		expect(getUnreadablePathReason("/tmp/photo.png")).toBeUndefined();
		expect(getUnreadablePathReason("/tmp/diagram.svg")).toBeUndefined();
		expect(getUnreadablePathReason("/tmp/report.pdf")).toBeUndefined();
	});
});

describe("read tool file kind guards", () => {
	it("rejects special files and directories but keeps /dev/null readable", () => {
		expect(getUnreadableFileKindReason("/tmp/a.txt", "file")).toBeUndefined();
		expect(getUnreadableFileKindReason("/dev/null", "other")).toBeUndefined();
		expect(getUnreadableFileKindReason("/tmp/dir", "directory")).toContain("is a directory");
		expect(getUnreadableFileKindReason("/tmp/pipe", "other")).toContain("special file");
	});
});

describe("read tool content guards", () => {
	it("rejects NUL bytes and UTF-16 files", () => {
		expect(getUnreadableContentReason("/tmp/a.txt", Buffer.from([0x61, 0x00, 0x62]))).toContain("NUL bytes");
		expect(getUnreadableContentReason("/tmp/a.txt", Buffer.from("\ufeffhello", "utf16le"))).toContain("UTF-16LE");
		expect(getUnreadableContentReason("/tmp/a.txt", Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toContain("UTF-16BE");
	});

	it("rejects images the model cannot be sent", () => {
		expect(
			getUnreadableContentReason("/tmp/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		).toBeUndefined();
		const apng = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from([0x00, 0x00, 0x00, 0x0d]),
			Buffer.from("IHDR"),
			Buffer.alloc(13),
			Buffer.alloc(4),
			Buffer.from([0x00, 0x00, 0x00, 0x08]),
			Buffer.from("acTL"),
			Buffer.alloc(8),
			Buffer.alloc(4),
		]);
		expect(getUnreadableContentReason("/tmp/a.png", apng)).toContain("animated PNG");
		expect(getUnreadableContentReason("/tmp/a.tif", Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toContain("TIFF");
		expect(getUnreadableContentReason("/tmp/a.heic", Buffer.from("0000ftypheic", "latin1"))).toContain("HEIC");
	});

	it("accepts ordinary text", () => {
		expect(getUnreadableContentReason("/tmp/a.txt", Buffer.from("hello\nworld\u00e9\n"))).toBeUndefined();
	});
});

describe("pdf detection", () => {
	it("matches the .pdf extension and the %PDF- header", () => {
		expect(isPdfPath("/tmp/report.PDF")).toBe(true);
		expect(isPdfPath("/tmp/report.txt")).toBe(false);
		expect(isPdfContent(PDF_BYTES)).toBe(true);
		expect(isPdfContent(Buffer.from("not a pdf"))).toBe(false);
	});

	it("finds a header that follows leading junk within 1024 bytes", () => {
		const head = Buffer.concat([Buffer.alloc(600, 0x20), Buffer.from("%PDF-1.7")]);
		expect(isPdfContent(head)).toBe(true);
	});
});

describe("harness read tool", () => {
	it("rejects binary files and device paths", async () => {
		const cwd = createTempDir();
		await writeFile(join(cwd, "bytes.bin"), Buffer.from([0x00, 0x01, 0x02]));
		await writeFile(join(cwd, "archive.zip"), "PK not really");
		const context = { env: new NodeExecutionEnv({ cwd }) };
		const tool = createReadTool();

		await expect(tool.execute("g1", { path: "bytes.bin" }, undefined, undefined, context)).rejects.toThrow(/binary/);
		await expect(tool.execute("g2", { path: "archive.zip" }, undefined, undefined, context)).rejects.toThrow(
			/binary/,
		);
		// The local env rejects device files as "Unsupported file type" before any read; the path
		// guard covers env implementations that do not classify file kinds.
		await expect(tool.execute("g3", { path: "/dev/zero" }, undefined, undefined, context)).rejects.toThrow(
			/device file|Unsupported file type/,
		);
	});

	it("delegates PDFs to the injected extractor", async () => {
		const cwd = createTempDir();
		await writeFile(join(cwd, "report.pdf"), PDF_BYTES);
		const context = { env: new NodeExecutionEnv({ cwd }) };
		const seen: Array<string | undefined> = [];
		const tool = createReadTool({
			pdfTextExtractor: async (bytes, pages) => {
				seen.push(pages);
				return `extracted ${bytes.length} bytes`;
			},
		});

		const result = await tool.execute("p1", { path: "report.pdf", pages: "2-4" }, undefined, undefined, context);
		expect(seen).toEqual(["2-4"]);
		expect(JSON.stringify(result.content)).toContain(`extracted ${PDF_BYTES.length} bytes`);
	});

	it("reports PDFs as unsupported without an extractor", async () => {
		const cwd = createTempDir();
		await writeFile(join(cwd, "report.pdf"), PDF_BYTES);
		const context = { env: new NodeExecutionEnv({ cwd }) };
		const tool = createReadTool();
		await expect(tool.execute("p2", { path: "report.pdf" }, undefined, undefined, context)).rejects.toThrow(
			/PDF support is not available/,
		);
	});

	it("still reads text files", async () => {
		const cwd = createTempDir();
		await writeFile(join(cwd, "notes.txt"), "hello\nworld\n");
		const context = { env: new NodeExecutionEnv({ cwd }) };
		const result = await createReadTool().execute("t1", { path: "notes.txt" }, undefined, undefined, context);
		expect(JSON.stringify(result.content)).toContain("hello");
	});
});
