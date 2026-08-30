import type * as ChildProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool, getToolPath, type ToolStatus } from "../src/utils/tools-manager.ts";

const originalOffline = process.env.PI_OFFLINE;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

afterEach(() => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
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
});
