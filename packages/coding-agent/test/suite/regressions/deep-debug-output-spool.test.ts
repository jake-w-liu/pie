import fs, { type WriteStream } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../../../src/core/bash-executor.ts";
import { type BashOperations, createBashTool } from "../../../src/core/tools/bash.ts";
import { OutputAccumulator } from "../../../src/core/tools/output-accumulator.ts";
import { OutputSpool } from "../../../src/core/tools/output-spool.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness;
const createWriteStream = fs.createWriteStream;
const streams: WriteStream[] = [];
beforeEach(async () => {
	harness = await createHarness();
	streams.length = 0;
	vi.spyOn(fs, "createWriteStream").mockImplementation((path, options) => {
		const stream = createWriteStream(path, options);
		streams.push(stream);
		return stream;
	});
	syncBuiltinESMExports();
});
afterEach(async () => {
	for (const stream of streams) {
		if (!stream.closed) {
			stream.destroy();
			await setImmediate();
		}
		if (typeof stream.path === "string" && fs.existsSync(stream.path)) fs.unlinkSync(stream.path);
	}
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	harness.cleanup();
});

describe("owned native output spools", () => {
	it("observes an asynchronous open failure before producer completion", async () => {
		const output = new OutputAccumulator({
			maxBytes: 1,
			tempFilePrefix: `absent-${basename(harness.tempDir)}/output`,
		});
		output.append(Buffer.from("spill"));
		expect(streams).toHaveLength(1);
		expect(streams[0].listenerCount("error")).toBeGreaterThan(0);
		await vi.waitFor(() => expect(output.snapshot().fullOutputPath).toBeUndefined());
		await expect(output.closeTempFile()).rejects.toMatchObject({ code: "ENOENT" });
		expect(streams[0].listenerCount("error")).toBe(0);
	});

	it.each(["write", "finish"] as const)(
		"retains native %s failures, never advertising a successful artifact",
		async (phase) => {
			const spool = new OutputSpool(join(harness.tempDir, `${phase}.log`));
			const stream = streams[0];
			const failure = new Error(`synthetic ${phase} ENOSPC`);
			if (phase === "write") {
				vi.spyOn(stream, "_write").mockImplementation((_chunk, _encoding, callback) => callback(failure));
				spool.write("data");
			} else {
				vi.spyOn(stream, "end").mockImplementation(() => {
					stream.destroy(failure);
					return stream;
				});
			}
			await expect(spool.close()).rejects.toBe(failure);
			expect(spool.getPath()).toBeUndefined();
			await expect(spool.close()).rejects.toBe(failure);
			expect(stream.listenerCount("error")).toBe(0);
			expect(stream.listenerCount("finish")).toBe(0);
		},
	);

	it("drains successful files before returning their path and closes idempotently", async () => {
		const output = new OutputAccumulator({ maxBytes: 4, tempFilePrefix: "pi-spool-regression" });
		output.append(Buffer.from("prefix"));
		output.append(Buffer.from("中tail"));
		output.finish();
		await output.closeTempFile();
		await output.closeTempFile();
		const path = output.snapshot().fullOutputPath;
		expect(path).toBeDefined();
		expect(fs.readFileSync(path!, "utf8")).toBe("prefix中tail");
		fs.unlinkSync(path!);
		expect(streams[0].listenerCount("error")).toBe(0);
	});
});

describe("spool failure propagation through both Bash callers", () => {
	it.each(["tool", "user"] as const)(
		"handles an early spool error while the %s operation is still active",
		async (caller) => {
			const failure = new Error("synthetic EACCES");
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("x".repeat(60000)));
					streams[0].destroy(failure);
					await gate;
					return { exitCode: 0 };
				},
			};
			const running =
				caller === "user"
					? executeBashWithOperations("offline", harness.tempDir, operations)
					: createBashTool(harness.tempDir, { operations }).execute("call", { command: "offline" });
			const rejected = expect(running).rejects.toBe(failure);
			await setImmediate();
			expect(streams[0].listenerCount("error")).toBeGreaterThan(0);
			release?.();
			await rejected;
		},
	);

	it.each(["tool", "user"] as const)("preserves command and spool errors during %s cancellation", async (caller) => {
		const controller = new AbortController();
		const commandError = new Error("aborted");
		const spoolError = new Error("synthetic ENOSPC");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("x".repeat(60000)));
				streams[0].destroy(spoolError);
				controller.abort();
				throw commandError;
			},
		};
		const running =
			caller === "user"
				? executeBashWithOperations("offline", harness.tempDir, operations, { signal: controller.signal })
				: createBashTool(harness.tempDir, { operations }).execute(
						"call",
						{ command: "offline" },
						controller.signal,
					);
		await expect(running).rejects.toMatchObject({ errors: [commandError, spoolError], cause: commandError });
	});

	it("does not convert artifact failure into success when abort races command success", async () => {
		const controller = new AbortController();
		const failure = new Error("synthetic ENOSPC");
		await expect(
			executeBashWithOperations(
				"offline",
				harness.tempDir,
				{
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("x".repeat(60000)));
						streams[0].destroy(failure);
						controller.abort();
						return { exitCode: 0 };
					},
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(failure);
	});

	it("preserves an ordinary command error and successful cancelled output", async () => {
		const commandError = new Error("command failed");
		await expect(
			executeBashWithOperations("offline", harness.tempDir, {
				exec: async () => {
					throw commandError;
				},
			}),
		).rejects.toBe(commandError);
		const controller = new AbortController();
		const result = await executeBashWithOperations(
			"offline",
			harness.tempDir,
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("kept output\n"));
					controller.abort();
					throw new Error("aborted");
				},
			},
			{ signal: controller.signal },
		);
		expect(result).toMatchObject({ output: "kept output\n", cancelled: true, exitCode: undefined });
	});
});

describe("custom user-Bash output admission lifetime", () => {
	it.each(["success", "failure", "cancelled"] as const)(
		"ignores callback output after %s settlement",
		async (mode) => {
			const controller = new AbortController();
			const failure = new Error("command rejected");
			let callback: ((data: Buffer) => void) | undefined;
			const chunks: string[] = [];
			const operations: BashOperations = {
				async exec(_command, _cwd, { onData }) {
					callback = onData;
					onData(Buffer.from("before\n"));
					if (mode === "cancelled") controller.abort();
					if (mode !== "success") throw failure;
					return { exitCode: 0 };
				},
			};
			const running = executeBashWithOperations("offline", harness.tempDir, operations, {
				signal: controller.signal,
				onChunk: (chunk) => chunks.push(chunk),
			});
			if (mode === "failure") await expect(running).rejects.toBe(failure);
			else expect(await running).toMatchObject({ output: "before\n", cancelled: mode === "cancelled" });
			if (!callback) throw new Error("Missing actual executor callback");
			try {
				callback(Buffer.from("x".repeat(60000)));
				expect(streams).toHaveLength(0);
				expect(chunks).toEqual(["before\n"]);
			} finally {
				// Capture/drain only streams this regression actually created, including
				// the old failing implementation's late unowned spool.
				for (const stream of streams) {
					const completion = finished(stream, { cleanup: true }).catch((error: unknown) => {
						if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_STREAM_PREMATURE_CLOSE")
							throw error;
					});
					stream.destroy();
					await completion;
				}
			}
		},
	);

	it.each(["success", "failure", "cancelled"] as const)(
		"seals callback admission before draining artifacts after %s",
		async (mode) => {
			const originalClose = OutputSpool.prototype.close;
			let enter = () => {};
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.spyOn(OutputSpool.prototype, "close").mockImplementation(async function (this: OutputSpool) {
				enter();
				await gate;
				return originalClose.call(this);
			});
			const controller = new AbortController();
			const failure = new Error("command rejected");
			let callback: ((data: Buffer) => void) | undefined;
			const chunks: string[] = [];
			const before = `before\n${"x".repeat(60000)}`;
			const operations: BashOperations = {
				async exec(_command, _cwd, { onData }) {
					callback = onData;
					onData(Buffer.from(before));
					if (mode === "cancelled") controller.abort();
					if (mode !== "success") throw failure;
					return { exitCode: 0 };
				},
			};
			const observed = executeBashWithOperations("offline", harness.tempDir, operations, {
				signal: controller.signal,
				onChunk: (chunk) => chunks.push(chunk),
			}).then(
				(result) => ({ ok: true as const, result }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			try {
				await entered;
				if (!callback) throw new Error("Missing actual executor callback");
				callback(Buffer.from("late output"));
				expect(chunks).toEqual([before]);
			} finally {
				release();
				await observed;
			}
			const outcome = await observed;
			if (mode === "failure") {
				expect(outcome.ok).toBe(false);
				if (outcome.ok) throw new Error("Expected command failure");
				expect(outcome.error).toBe(failure);
			} else {
				expect(outcome.ok).toBe(true);
				if (!outcome.ok) throw outcome.error;
				expect(outcome.result.cancelled).toBe(mode === "cancelled");
				expect(outcome.result.fullOutputPath).toBeDefined();
			}
			expect(streams).toHaveLength(1);
			expect(streams[0].closed).toBe(true);
			expect(typeof streams[0].path).toBe("string");
			expect(fs.readFileSync(streams[0].path, "utf8")).toBe(before);
		},
	);
});
