/**
 * Regression tests for the harness audit fixes:
 *
 * - `HarnessEventBus.emit` must not let one throwing listener starve the listeners
 *   after it or skip the watch pass, and a rejected async listener must not become
 *   an unhandled rejection.
 * - `createTempFile` hides the directory it allocates, so `cleanup()` must reclaim it;
 *   otherwise every spilled bash command leaks one directory.
 * - The write tool reported `content.length` (UTF-16 code units) as a byte count.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { HarnessEventBus, type HarnessEventListener } from "../../src/harness/events.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("HarnessEventBus", () => {
	it("delivers to remaining listeners after one throws, then propagates", () => {
		const bus = new HarnessEventBus();
		const seen: string[] = [];
		bus.on("run_end", () => {
			throw new Error("listener exploded");
		});
		bus.on("run_end", () => {
			seen.push("second");
		});

		expect(() => bus.emit({ type: "run_end", lane: "a", runId: "1", outcome: "completed", leafId: "1" })).toThrow(
			"listener exploded",
		);
		expect(seen).toEqual(["second"]);
	});

	it("still runs the watch pass when a type listener throws", () => {
		const bus = new HarnessEventBus();
		const watched: string[] = [];
		bus.on("run_end", () => {
			throw new Error("listener exploded");
		});
		const handle = bus.watch(() => "snapshot");
		handle.start(() => {
			watched.push("watcher");
		});

		expect(() => bus.emit({ type: "run_end", lane: "a", runId: "1", outcome: "completed", leafId: "1" })).toThrow();
		expect(watched).toEqual(["watcher"]);
	});

	it("tolerates a listener that returns a non-thenable truthy value", () => {
		const bus = new HarnessEventBus();
		const seen: number[] = [];
		// Array.prototype.push returns a number: truthy, but not a Promise. TypeScript
		// rejects it as a listener, so the cast stands in for an untyped JS extension
		// reaching the bus. Calling .catch on it would raise a TypeError out of emit().
		bus.on("run_end", (() => seen.push(1)) as unknown as HarnessEventListener);
		bus.on("run_end", () => {
			seen.push(2);
		});

		expect(() =>
			bus.emit({ type: "run_end", lane: "a", runId: "1", outcome: "completed", leafId: "1" }),
		).not.toThrow();
		expect(seen).toEqual([1, 2]);
	});

	it("contains an async listener rejection instead of leaving it unhandled", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const bus = new HarnessEventBus();
			let ran = false;
			bus.on("run_end", () => {
				ran = true;
				return Promise.reject(new Error("async listener failed"));
			});

			// Must not throw synchronously: the rejection settles after emit() returns.
			bus.emit({ type: "run_end", lane: "a", runId: "1", outcome: "completed", leafId: "1" });
			expect(ran).toBe(true);

			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

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
