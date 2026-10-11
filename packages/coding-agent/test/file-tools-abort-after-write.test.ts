import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

/**
 * Cancellation is only safe up to the moment the write commits.
 *
 * An abort that lands while the atomic write is in flight used to throw
 * "Operation aborted" even though the file was already changed. The model reads
 * that as "nothing happened" and retries: the retry either fails because
 * `oldText` is already replaced, or - worse - applies a second, unintended
 * replacement when the same text occurs again. After the write lands the tool
 * must report what actually happened.
 */
describe("file tools cancelled after the write committed", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-write-abort-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("edit reports success when the abort lands during the write", async () => {
		const filePath = join(dir, "edit.txt");
		writeFileSync(filePath, "alpha\nbeta\n", "utf-8");
		const controller = new AbortController();
		let stored = "alpha\nbeta\n";

		const definition = createEditTool(dir, {
			operations: {
				readFile: async () => Buffer.from(stored, "utf-8"),
				access: async () => {},
				writeFile: async (_path, content) => {
					stored = content;
					// The user cancels while the atomic write is in flight; the write
					// still commits before returning.
					controller.abort();
				},
			},
		});

		const result = await definition.execute(
			"call-1",
			{ path: "edit.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			controller.signal,
		);

		expect(result?.isError).toBeFalsy();
		expect(stored).toBe("ALPHA\nbeta\n");
	});

	it("write reports success when the abort lands during the write", async () => {
		const filePath = join(dir, "write.txt");
		const controller = new AbortController();
		let wrote = false;

		const definition = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					writeFileSync(path, content as string, "utf-8");
					wrote = true;
					controller.abort();
				},
			},
		});

		const result = await definition.execute("call-1", { path: "write.txt", content: "payload\n" }, controller.signal);

		expect(result?.isError).toBeFalsy();
		expect(wrote).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toBe("payload\n");
	});

	it("edit still refuses to write when the abort lands before the write", async () => {
		const filePath = join(dir, "early.txt");
		writeFileSync(filePath, "alpha\n", "utf-8");
		const controller = new AbortController();
		controller.abort();
		let wrote = false;

		const definition = createEditTool(dir, {
			operations: {
				readFile: async () => Buffer.from("alpha\n", "utf-8"),
				access: async () => {},
				writeFile: async (_path, content) => {
					wrote = true;
					writeFileSync(filePath, content as string, "utf-8");
				},
			},
		});

		await expect(
			definition.execute(
				"call-1",
				{ path: "early.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
				controller.signal,
			),
		).rejects.toThrow("Operation aborted");
		expect(wrote).toBe(false);
		expect(readFileSync(filePath, "utf-8")).toBe("alpha\n");
	});

	it("write still refuses to write when the abort lands before the write", async () => {
		const controller = new AbortController();
		controller.abort();
		let wrote = false;

		const definition = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async () => {
					wrote = true;
				},
			},
		});

		await expect(
			definition.execute("call-1", { path: "never.txt", content: "x\n" }, controller.signal),
		).rejects.toThrow("Operation aborted");
		expect(wrote).toBe(false);
	});
});
