import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

const OTHER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
	"base64",
);

/** Context whose context entries contain the given tool result ids. */
function contextWithToolResults(toolCallIds: string[]): ExtensionContext {
	return {
		sessionManager: {
			buildContextEntries: () =>
				toolCallIds.map((toolCallId) => ({ type: "message", message: { role: "toolResult", toolCallId } })),
		},
	} as unknown as ExtensionContext;
}

function createImageTool(getBytes: () => Buffer, ctx?: ExtensionContext) {
	const tool = createReadToolDefinition("/tmp", {
		operations: {
			access: async () => {},
			readFile: async () => getBytes(),
			detectImageMimeType: async () => "image/png",
		},
	});
	return () =>
		// The tool tolerates an undefined context at runtime; the definition's type requires one.
		tool.execute("call", { path: "screenshot.png" }, undefined, undefined, ctx as ExtensionContext);
}

describe("image re-read deduplication", () => {
	it("sends the image on the first read", async () => {
		const read = createImageTool(() => TINY_PNG);
		const result = await read();
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	it("returns a stub when the identical image is still in context", async () => {
		const read = createImageTool(() => TINY_PNG, contextWithToolResults(["call"]));
		const first = await read();
		expect(first.content.some((block) => block.type === "image")).toBe(true);

		const second = await read();
		expect(second.content.some((block) => block.type === "image")).toBe(false);
		expect(JSON.stringify(second.content)).toContain("still in context");
	});

	it("re-sends the image after the earlier result left the context", async () => {
		let entries = ["call"];
		const ctx = {
			sessionManager: {
				buildContextEntries: () =>
					entries.map((toolCallId) => ({ type: "message", message: { role: "toolResult", toolCallId } })),
			},
		} as unknown as ExtensionContext;
		const read = createImageTool(() => TINY_PNG, ctx);

		await read();
		// Compaction dropped the earlier tool result from the model context.
		entries = [];
		const afterCompaction = await read();
		expect(afterCompaction.content.some((block) => block.type === "image")).toBe(true);
	});

	it("re-sends the image when the file content changed", async () => {
		let bytes = TINY_PNG;
		const read = createImageTool(() => bytes, contextWithToolResults(["call"]));
		await read();
		bytes = OTHER_PNG;
		const changed = await read();
		expect(changed.content.some((block) => block.type === "image")).toBe(true);
	});

	it("does not deduplicate without an extension context", async () => {
		const read = createImageTool(() => TINY_PNG);
		await read();
		const second = await read();
		expect(second.content.some((block) => block.type === "image")).toBe(true);
	});
});
