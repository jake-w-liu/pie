import { describe, expect, it } from "vitest";
import type { ReadOperations } from "../src/core/tools/read.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const PDF_BYTES = Buffer.from(
	[
		"%PDF-1.4",
		"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
		"4 0 obj<</Length 46>>stream",
		"BT /F1 12 Tf 10 100 Td (Custom ops PDF body) Tj ET",
		"endstream",
		"endobj",
		"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
		"trailer<</Root 1 0 R>>",
		"%%EOF",
	].join("\n"),
	"utf8",
);

interface Recorder {
	ops: ReadOperations;
	reads: number;
	heads: number;
}

/** Operations like a remote backend: only the three required capabilities. */
function createMinimalOps(contents: Buffer, capabilities: { head?: boolean; size?: number } = {}): Recorder {
	const recorder: Recorder = {
		reads: 0,
		heads: 0,
		ops: {
			access: async () => {},
			readFile: async () => {
				recorder.reads++;
				return contents;
			},
		},
	};
	if (capabilities.head) {
		recorder.ops.readHead = async (_path, byteCount) => {
			recorder.heads++;
			return contents.subarray(0, byteCount);
		};
	}
	if (capabilities.size !== undefined) {
		recorder.ops.fileSize = async () => capabilities.size;
	}
	return recorder;
}

describe("read tool with backend operations that lack optional capabilities", () => {
	it("reads a real PDF once, without size or head capabilities", async () => {
		const recorder = createMinimalOps(PDF_BYTES);
		const tool = createReadToolDefinition("/tmp", { operations: recorder.ops });
		const result = await tool.execute("ops-1", { path: "report.pdf" }, undefined, undefined, undefined as never);
		expect(JSON.stringify(result.content)).toContain("Custom ops PDF body");
		expect(recorder.reads).toBe(1);
	});

	it("reads a misnamed .pdf as text from the same single read", async () => {
		const recorder = createMinimalOps(Buffer.from("plain text with a pdf name\n"));
		const tool = createReadToolDefinition("/tmp", { operations: recorder.ops });
		const result = await tool.execute("ops-2", { path: "notes.pdf" }, undefined, undefined, undefined as never);
		expect(JSON.stringify(result.content)).toContain("plain text with a pdf name");
		expect(recorder.reads).toBe(1);
	});

	it("answers a misnamed .pdf from the head read alone when the backend supports it", async () => {
		const recorder = createMinimalOps(Buffer.from("plain text with a pdf name\n"), { head: true });
		const tool = createReadToolDefinition("/tmp", { operations: recorder.ops });
		const result = await tool.execute("ops-3", { path: "notes.pdf" }, undefined, undefined, undefined as never);
		expect(JSON.stringify(result.content)).toContain("plain text with a pdf name");
		// The head confirmed the file is not a PDF, so the follow-up branch streams with its own read.
		expect(recorder.heads).toBe(1);
	});

	it("refuses an oversized PDF when the backend reports its size", async () => {
		const recorder = createMinimalOps(PDF_BYTES, { head: true, size: 200 * 1024 * 1024 });
		const tool = createReadToolDefinition("/tmp", { operations: recorder.ops });
		await expect(
			tool.execute("ops-4", { path: "report.pdf" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/above the read tool's 64\.0MB PDF limit/);
		expect(recorder.reads).toBe(0);
	});

	it("still applies path and content guards without file-kind support", async () => {
		const binary = createMinimalOps(Buffer.from([0x61, 0x00, 0x62]));
		const binaryTool = createReadToolDefinition("/tmp", { operations: binary.ops });
		await expect(
			binaryTool.execute("ops-5", { path: "data.dat" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/NUL bytes/);

		const extension = createMinimalOps(Buffer.from("PK zip-ish"));
		const extensionTool = createReadToolDefinition("/tmp", { operations: extension.ops });
		await expect(
			extensionTool.execute("ops-6", { path: "archive.zip" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/\.zip files are binary/);

		const device = createMinimalOps(Buffer.from("ignored"));
		const deviceTool = createReadToolDefinition("/tmp", { operations: device.ops });
		await expect(
			deviceTool.execute("ops-7", { path: "/dev/zero" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/device file/);
		expect(device.reads).toBe(0);
	});
});
