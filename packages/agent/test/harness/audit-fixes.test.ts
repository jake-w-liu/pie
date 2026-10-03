/**
 * Regression tests for the harness audit fixes:
 *
 * - `createTempFile` hides the directory it allocates, so `cleanup()` must reclaim it;
 *   otherwise every spilled bash command leaks one directory.
 * - The write tool reported `content.length` (UTF-16 code units) as a byte count.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("createTempFile cleanup", () => {
	it("reclaims the hidden temp directory on cleanup", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const created = await env.createTempFile({ prefix: "spill-", suffix: ".log" });
		expect(created.ok).toBe(true);
		const filePath = getOrThrow(created);
		expect(existsSync(filePath)).toBe(true);
		const parent = filePath.slice(0, filePath.lastIndexOf("/"));

		await env.cleanup();

		expect(existsSync(filePath)).toBe(false);
		expect(existsSync(parent)).toBe(false);
	});
});

describe("write tool byte count", () => {
	it("reports UTF-8 bytes, not UTF-16 code units", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		// "é" is 2 UTF-8 bytes but 1 UTF-16 code unit; "😀" is 4 bytes but 2 code units.
		const content = "é😀";
		const result = await createWriteTool().execute(
			"write-bytes",
			{ path: "bytes.txt", content },
			undefined,
			undefined,
			{ env },
		);

		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toBe(`Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to bytes.txt`);
		expect(text).not.toContain(`wrote ${content.length} bytes`);
	});
});
