import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createFindTool, getFindProcessError } from "../src/core/tools/find.ts";
import { createGrepTool, createUtf8LineDecoder } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { truncateLine } from "../src/core/tools/truncate.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("coding-agent tool audit regressions", () => {
	it.skipIf(process.platform === "win32")(
		"settles aborts after killing regrouped descendants",
		async () => {
			const tool = createBashTool(tmpdir());
			const controller = new AbortController();
			const started = Date.now();
			const command = `set -m; node -e "setInterval(()=>console.log('tick'),20)" & sleep 10`;
			const execution = tool.execute("test", { command }, controller.signal);
			setTimeout(() => controller.abort(), 300);
			await expect(execution).rejects.toThrow(/aborted/i);
			expect(Date.now() - started).toBeLessThan(2_000);
		},
		5_000,
	);

	it.skipIf(process.platform === "win32")("rejects a command terminated by a signal", async () => {
		await expect(createBashTool(tmpdir()).execute("test", { command: "kill -9 $$" })).rejects.toThrow(
			/terminated by signal/,
		);
	});

	it("preserves untouched mixed line-ending bytes during edits", async () => {
		const directory = temporaryDirectory("pi-edit-cr-");
		const file = join(directory, "mixed.txt");
		writeFileSync(file, "progress 10%\r50%\r100%\nversion = 1\r\n");
		await createEditTool(directory).execute("test", {
			path: "mixed.txt",
			edits: [{ oldText: "version = 1", newText: "version = 2" }],
		} as never);
		expect(await import("node:fs/promises").then(({ readFile }) => readFile(file, "utf8"))).toBe(
			"progress 10%\r50%\r100%\nversion = 2\r\n",
		);
	});

	it("removes abort listeners after ls failures", async () => {
		const signal = new AbortController().signal;
		const tool = createLsTool("/", {
			operations: {
				exists: async () => false,
				stat: async () => ({ isDirectory: () => true }) as never,
				readdir: async () => [],
			},
		});
		for (let index = 0; index < 4; index++) await expect(tool.execute("test", {}, signal)).rejects.toThrow();
		expect(getEventListeners(signal, "abort")).toHaveLength(0);
	});

	it("does not count a terminal newline as another readable line", async () => {
		const directory = temporaryDirectory("pi-read-lines-");
		writeFileSync(join(directory, "lines.txt"), "a\nb\nc\n");
		const tool = createReadTool(directory);
		expect(textOf(await tool.execute("test", { path: "lines.txt", limit: 3 }))).toBe("a\nb\nc");
		await expect(tool.execute("test", { path: "lines.txt", offset: 4 })).rejects.toThrow(/3 lines total/);
	});

	it("streams a large file when only its first line is requested", async () => {
		const directory = temporaryDirectory("pi-read-large-");
		const file = join(directory, "large.log");
		writeFileSync(file, "x\n".repeat(2_000_000));
		const output = textOf(await createReadTool(directory).execute("test", { path: file, limit: 1 }));
		expect(output).toContain("1999999 more lines");
	});

	it("decodes UTF-8 code points split across grep stdout chunks", () => {
		const lines: string[] = [];
		const decoder = createUtf8LineDecoder((line) => lines.push(line));
		const encoded = Buffer.from("prefix 漢 suffix\n", "utf8");
		const split = encoded.indexOf(Buffer.from("漢")) + 1;
		decoder.write(encoded.subarray(0, split));
		decoder.write(encoded.subarray(split));
		decoder.end();
		expect(lines).toEqual(["prefix 漢 suffix"]);
	});

	it("never cuts a UTF-16 surrogate pair", () => {
		const result = truncateLine(`${"a".repeat(498)}😀z`, 499).text;
		expect(Buffer.from(result).toString("utf8")).not.toContain("�");
	});

	it("treats a nonzero fd status as an error even when stdout had paths", () => {
		expect(getFindProcessError(2, "permission denied")?.message).toBe("permission denied");
		expect(getFindProcessError(0, "")).toBeUndefined();
	});

	it("round-trips trailing spaces in find results and excludes .git", async () => {
		const directory = temporaryDirectory("pi-find-paths-");
		writeFileSync(join(directory, "trailing.ts "), "x");
		mkdirSync(join(directory, ".git"));
		writeFileSync(join(directory, ".git", "hidden.ts"), "x");
		const output = textOf(await createFindTool(directory).execute("test", { pattern: "*.ts*" }));
		expect(output).toContain("trailing.ts ");
		expect(output).not.toContain(".git");
	});

	it("keeps trailing grep context at a match limit and excludes .git", async () => {
		const directory = temporaryDirectory("pi-grep-context-");
		writeFileSync(join(directory, "source.txt"), "before\nMATCH\nafter1\nafter2\nfar\nMATCH\n");
		mkdirSync(join(directory, ".git"));
		writeFileSync(join(directory, ".git", "secret.txt"), "MATCH\n");
		const output = textOf(
			await createGrepTool(directory).execute("test", { pattern: "MATCH", limit: 1, context: 2 }),
		);
		expect(output).toContain("source.txt-3- after1");
		expect(output).toContain("source.txt-4- after2");
		expect(output).not.toContain("secret.txt");
	});

	it("exposes spool backpressure to producers", async () => {
		let producerObservedBackpressure = false;
		let producerWaitedForDrain = false;
		const tool = createBashTool(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, { onData, waitForDrain }) => {
					for (let index = 0; index < 100; index++) {
						if (onData(Buffer.alloc(64 * 1024, "x"), "stdout") === false) {
							producerObservedBackpressure = true;
							await waitForDrain?.();
							producerWaitedForDrain = true;
							break;
						}
					}
					return { exitCode: 0 };
				},
			},
		});

		const result = await tool.execute("backpressure", { command: "produce" });
		expect(producerObservedBackpressure).toBe(true);
		expect(producerWaitedForDrain).toBe(true);
		if (result.details?.fullOutputPath) rmSync(result.details.fullOutputPath, { force: true });
	});

	it("returns promptly for a WebP chunk with the high size bit set", async () => {
		const script = `
			import { processImage } from ${JSON.stringify(new URL("../src/utils/image-process.ts", import.meta.url).href)};
			const bytes = Buffer.alloc(20);
			bytes.write('RIFF', 0); bytes.write('WEBP', 8); bytes.write('JUNK', 12); bytes.writeUInt32LE(0x80000000, 16);
			await processImage(bytes, 'image/webp');
		`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
		const exit = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
		try {
			expect(await exit).toBe(0);
		} finally {
			clearTimeout(timer);
		}
	}, 4_000);
});
