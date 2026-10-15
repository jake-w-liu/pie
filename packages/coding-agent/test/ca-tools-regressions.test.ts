import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("refuses to edit a file that is not valid UTF-8 and leaves its bytes unchanged", async () => {
		const directory = temporaryDirectory("pi-edit-latin1-");
		const file = join(directory, "legacy.c");
		// Latin-1 "é" (0xE9) on a line the edit does not touch.
		const original = Buffer.concat([
			Buffer.from("/* Auteur: Ren"),
			Buffer.from([0xe9]),
			Buffer.from(" */\nint x = 1;\n"),
		]);
		writeFileSync(file, original);
		await expect(
			createEditTool(directory).execute("test", {
				path: "legacy.c",
				edits: [{ oldText: "int x = 1;", newText: "int x = 2;" }],
			}),
		).rejects.toThrow(/not valid UTF-8/);
		expect(readFileSync(file).equals(original)).toBe(true);
	});

	it("replaces exactly the matched range in a file with mixed line endings", async () => {
		const directory = temporaryDirectory("pi-edit-mixed-");
		const file = join(directory, "mixed.txt");
		const tool = createEditTool(directory);
		// The CRLF after "b" lies outside the match and must stay right after it.
		writeFileSync(file, "a\nb\r\nc\n");
		await tool.execute("test", { path: "mixed.txt", edits: [{ oldText: "b", newText: "b\nb" }] });
		expect(readFileSync(file, "utf8")).toBe("a\nb\nb\r\nc\n");
		// A line-for-line edit keeps each replaced line's own ending.
		writeFileSync(file, "a\nb\r\nc\n");
		await tool.execute("test", { path: "mixed.txt", edits: [{ oldText: "b\nc", newText: "B\nC" }] });
		expect(readFileSync(file, "utf8")).toBe("a\nB\r\nC\n");
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

	it("anchors a grep glob containing a slash at the search directory", async () => {
		const directory = temporaryDirectory("pi-grep-glob-");
		mkdirSync(join(directory, "src"));
		mkdirSync(join(directory, "test"));
		writeFileSync(join(directory, "src", "a.ts"), "needle\n");
		writeFileSync(join(directory, "test", "b.ts"), "needle\n");
		const tool = createGrepTool(directory);
		for (const glob of ["src/**/*.ts", "./src/*.ts"]) {
			const result = await tool.execute("test", { pattern: "needle", glob, outputMode: "files_with_matches" });
			expect(textOf(result)).toBe("src/a.ts");
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps grep matches when another path cannot be read",
		async () => {
			const directory = temporaryDirectory("pi-grep-unreadable-");
			mkdirSync(join(directory, "ok"));
			writeFileSync(join(directory, "ok", "a.txt"), "needle\n");
			const locked = join(directory, "locked");
			mkdirSync(locked);
			chmodSync(locked, 0o000);
			try {
				const tool = createGrepTool(directory);
				for (const outputMode of ["content", "files_with_matches", "count"] as const) {
					const output = textOf(await tool.execute("test", { pattern: "needle", outputMode }));
					expect(output).toMatch(outputMode === "count" ? /^1\n/ : /ok\/a\.txt/);
					expect(output).toContain("could not be searched");
				}
			} finally {
				chmodSync(locked, 0o755);
			}
		},
	);

	it("shows grep matches on lines that are not valid UTF-8", async () => {
		const directory = temporaryDirectory("pi-grep-latin1-");
		// Latin-1 "\u00e9" (0xE9): rg reports such a line as base64 bytes instead of text.
		const bytes = Buffer.concat([Buffer.from("/* r"), Buffer.from([0xe9]), Buffer.from("sum */ needle;\n")]);
		writeFileSync(join(directory, "legacy.c"), bytes);
		const output = textOf(await createGrepTool(directory).execute("test", { pattern: "needle" }));
		expect(output).toContain("legacy.c:1: /* r\ufffdsum */ needle;");
	});

	it("searches each decoded chunk once while reassembling a long grep line", () => {
		const chunk = Buffer.alloc(16 * 1024, "x");
		const chunkCount = 128;
		const lines: string[] = [];
		const decoder = createUtf8LineDecoder((line) => lines.push(line));
		// Searching the whole pending line again for every chunk made reassembly quadratic. Count the
		// text handed to the newline search: linear reassembly searches each character about once.
		const originalIndexOf = String.prototype.indexOf;
		let searched = 0;
		const indexOf = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
			this: string,
			searchString: string,
			position?: number,
		) {
			searched += this.length - (position ?? 0);
			return originalIndexOf.call(this, searchString, position);
		});
		try {
			for (let index = 0; index < chunkCount; index++) decoder.write(chunk);
			decoder.write(Buffer.from("\n"));
			decoder.end();
		} finally {
			indexOf.mockRestore();
		}
		expect(lines).toEqual(["x".repeat(chunk.length * chunkCount)]);
		expect(searched).toBeLessThan(2 * chunk.length * chunkCount);
	});

	it("anchors a find pattern containing a slash at the search directory", async () => {
		// A directory named "src" above the search root must not satisfy "src/**".
		const project = join(temporaryDirectory("pi-find-anchor-"), "src", "proj");
		mkdirSync(join(project, "src"), { recursive: true });
		mkdirSync(join(project, "test"));
		writeFileSync(join(project, "src", "a.ts"), "");
		writeFileSync(join(project, "test", "b.ts"), "");
		const tool = createFindTool(project);
		for (const pattern of ["src/**/*.ts", "./src/*.ts"]) {
			expect(textOf(await tool.execute("test", { pattern }))).toBe("src/a.ts");
		}
	});

	async function runBashWithOutput(output: string): Promise<string> {
		const tool = createBashTool(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(output), "stdout");
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("long-line", { command: "produce" });
		if (result.details?.fullOutputPath) rmSync(result.details.fullOutputPath, { force: true });
		return textOf(result);
	}

	it("shows the end of an overlong last output line that ends with a newline", async () => {
		// Beyond twice the rolling tail, the retained tail starts inside this line.
		const output = await runBashWithOutput(`${"x".repeat(300 * 1024)}\n`);
		expect(output.startsWith("x".repeat(1024))).toBe(true);
		expect(output).toContain("[Showing last 50.0KB of line 1 (line is 300.0KB).");
	});

	it("reports the size of an overlong last line that ends with a newline", async () => {
		const output = await runBashWithOutput(`${"x".repeat(150 * 1024)}\n`);
		expect(output).toContain("[Showing last 50.0KB of line 1 (line is 150.0KB).");
	});

	it("shows the end of an overlong output line that only empty lines follow", async () => {
		// 150KB fits the rolling tail; at 300KB the retained tail starts inside the line.
		for (const [size, ending] of [
			[150, "\n"],
			[300, "\n"],
			[150, "\r\n"],
		] as const) {
			const output = await runBashWithOutput(`first line${ending}${"x".repeat(size * 1024)}${ending}${ending}`);
			expect(output.startsWith("x".repeat(1024))).toBe(true);
			expect(output).toContain(`[Showing last 50.0KB of line 2 (line is ${size}.0KB).`);
		}
		// The notice counts only the partial line, not the empty lines shown after it:
		// 50KB budget minus 1500 newline bytes leaves 49700 bytes (48.5KB) of the line.
		const manyBlank = await runBashWithOutput(`${"x".repeat(150 * 1024)}${"\n".repeat(1501)}`);
		expect(manyBlank).toContain("[Showing last 48.5KB of line 1 (line is 150.0KB).");
	});

	it.skipIf(process.platform === "win32")(
		"settles a timeout while a detached descendant keeps writing",
		async () => {
			const directory = temporaryDirectory("pi-bash-timeout-");
			// `detached` calls setsid and the launcher exits at once, so the writer leaves the shell's
			// process tree and group but keeps writing to the inherited stdout pipe. It exits by itself
			// once that pipe closes, and after 20 seconds at the latest.
			writeFileSync(
				join(directory, "writer.cjs"),
				`process.stdout.on("error", () => process.exit(0));
				setInterval(() => console.log("tick"), 20);
				setTimeout(() => process.exit(0), 20_000);`,
			);
			writeFileSync(
				join(directory, "launch.cjs"),
				`require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(directory, "writer.cjs"))}], {
					detached: true,
					stdio: ["ignore", "inherit", "inherit"],
				}).unref();`,
			);
			const started = Date.now();
			const command = `${JSON.stringify(process.execPath)} launch.cjs; sleep 30`;
			await expect(createBashTool(directory).execute("test", { command, timeout: 1 })).rejects.toThrow(
				/timed out after 1 seconds/,
			);
			// Waiting for the pipes to go idle would last as long as the writer keeps writing.
			expect(Date.now() - started).toBeLessThan(5_000);
		},
		15_000,
	);

	it("reads a window larger than the output limit like an unlimited read", async () => {
		const directory = temporaryDirectory("pi-read-limit-");
		writeFileSync(
			join(directory, "many.txt"),
			Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n"),
		);
		const tool = createReadTool(directory);
		const unlimited = await tool.execute("test", { path: "many.txt" });
		const limited = await tool.execute("test", { path: "many.txt", limit: 1_000_000 });
		expect(limited).toEqual(unlimited);
	});

	it.skipIf(process.platform === "win32")("lists a dangling symlink", async () => {
		const directory = temporaryDirectory("pi-ls-dangling-");
		writeFileSync(join(directory, "real.txt"), "");
		symlinkSync(join(directory, "missing-target"), join(directory, "dangling-link"));
		expect(textOf(await createLsTool(directory).execute("test", {}))).toBe("dangling-link\nreal.txt");
	});
});
