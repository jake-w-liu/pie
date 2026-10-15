import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-file-args-"));
	tempDirs.push(dir);
	return dir;
}

describe("processFileArguments with non-regular files", () => {
	it("reports a directory argument as a CLI error", async () => {
		const dir = join(createTempDir(), "somedir");
		mkdirSync(dir);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as typeof process.exit);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(processFileArguments([dir])).rejects.toThrow("exit:1");
		expect(error).toHaveBeenCalledWith(expect.stringContaining(`${dir} is a directory`));
	});

	it.skipIf(process.platform === "win32")("reads a named pipe in full", async () => {
		const fifo = join(createTempDir(), "pipe");
		execFileSync("mkfifo", [fifo]);
		// The writer blocks until the reader opens the pipe, then writes and closes it.
		const writer = spawn("sh", ["-c", 'printf "SECRET-CONTENT" > "$1"', "sh", fifo], { stdio: "ignore" });
		const writerExit = new Promise<number | null>((resolve) => writer.on("close", resolve));
		try {
			const result = await processFileArguments([fifo]);

			expect(result.images).toEqual([]);
			expect(result.text).toBe(`<file name="${fifo}">\nSECRET-CONTENT\n</file>\n`);
			expect(await writerExit).toBe(0);
		} finally {
			// A reader that skipped the pipe would leave the writer blocked in open().
			writer.kill();
		}
	});
});
