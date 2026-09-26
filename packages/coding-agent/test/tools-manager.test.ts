import type * as ChildProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTool, getToolPath, type ToolStatus } from "../src/utils/tools-manager.ts";

const originalOffline = process.env.PI_OFFLINE;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
		// Keep the install path off the real filesystem: this suite only needs to
		// observe the extraction decision, not to produce an installed binary.
		mkdirSync: vi.fn(() => undefined),
		renameSync: vi.fn(() => undefined),
		rmSync: vi.fn(() => undefined),
		chmodSync: vi.fn(() => undefined),
		readdirSync: vi.fn(() => []),
		createWriteStream: vi.fn(() => ({}) as never),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

vi.mock("stream/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("stream/promises")>();
	return {
		...actual,
		pipeline: vi.fn(async () => undefined),
	};
});

vi.mock("../src/utils/management-http.ts", () => ({
	fetchWithRetry: vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({ tag_name: "v1.0.0" }),
		// A real web stream: downloadFile hands it to Readable.fromWeb.
		body: new Response("archive-bytes").body as never,
	})),
}));

afterEach(() => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	vi.mocked(spawnSync).mockClear();
});

describe("ensureTool", () => {
	it("reports status through a callback without writing to the console", async () => {
		process.env.PI_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});

	describe("getToolPath", () => {
		it("bounds commandExists with a timeout so a wedged binary cannot block synchronously", () => {
			const spawnSyncMock = vi.mocked(spawnSync);
			spawnSyncMock.mockClear();

			expect(getToolPath("fd")).toBeNull();

			expect(spawnSyncMock).toHaveBeenCalled();
			for (const call of spawnSyncMock.mock.calls) {
				const options = call[2] as { timeout?: number } | undefined;
				expect(options?.timeout).toBeGreaterThan(0);
			}
		});
	});

	describe("archive extraction", () => {
		// The suite runs with PI_OFFLINE set, which short-circuits ensureTool
		// before it ever reaches the extraction step.
		beforeEach(() => {
			delete process.env.PI_OFFLINE;
		});

		const PROBE_COMMANDS = new Set(["fd", "fdfind", "rg"]);

		function extractionCalls(): Array<{ command: string; options?: { timeout?: number } }> {
			return vi
				.mocked(spawnSync)
				.mock.calls.filter((call) => !PROBE_COMMANDS.has(String(call[0])))
				.map((call) => ({
					command: String(call[0]),
					options: call[2] as { timeout?: number } | undefined,
				}));
		}

		it("bounds every extraction command with a timeout", async () => {
			vi.mocked(spawnSync).mockImplementation((command) =>
				PROBE_COMMANDS.has(String(command))
					? ({ error: new Error("not found") } as never)
					: ({ status: 0 } as never),
			);

			await ensureTool("fd");

			const calls = extractionCalls();
			expect(calls.length).toBeGreaterThan(0);
			for (const call of calls) {
				expect(call.options?.timeout).toBeGreaterThan(0);
			}
		});

		it("reports a timed-out extraction as a failure instead of installing from a partial tree", async () => {
			const timeoutError = Object.assign(new Error("spawnSync tar ETIMEDOUT"), { code: "ETIMEDOUT" });
			vi.mocked(spawnSync).mockImplementation((command) =>
				PROBE_COMMANDS.has(String(command))
					? ({ error: new Error("not found") } as never)
					: ({ status: null, signal: "SIGTERM", error: timeoutError } as never),
			);
			const statuses: ToolStatus[] = [];

			const result = await ensureTool("fd", (status) => statuses.push(status));

			expect(result).toBeUndefined();
			const failure = statuses.find((status) => status.type === "warning");
			expect(failure?.message).toMatch(/Failed to download fd: Failed to extract/);
			expect(failure?.message).toMatch(/timed out after \d+ms/);
			// A timed-out extraction must not be mistaken for a completed install.
			expect(statuses.some((status) => status.message.includes("installed to"))).toBe(false);
		});
	});
});
