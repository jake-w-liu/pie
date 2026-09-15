import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreStdout, setFatalStdoutCleanup, writeRawStdout } from "../src/core/output-guard.ts";

describe("audit fatal stdout cleanup (L3)", () => {
	afterEach(() => {
		setFatalStdoutCleanup(undefined);
		restoreStdout();
		vi.restoreAllMocks();
	});

	it("awaits async cleanup before exiting on a fatal write", async () => {
		const order: string[] = [];
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as unknown as (code?: string | number | null | undefined) => never);
		// Fail every raw stdout write so the fatal path triggers deterministically.
		vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: unknown,
			callback?: (error?: Error | null) => void,
		) => {
			if (typeof callback === "function") callback(new Error("EPIPE"));
			return false;
		}) as unknown as typeof process.stdout.write);

		setFatalStdoutCleanup(async () => {
			order.push("cleanup:start");
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("cleanup:done");
		});

		writeRawStdout("protocol line\n");
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(1));
		// The async dispose completed before process.exit ran.
		expect(order).toEqual(["cleanup:start", "cleanup:done"]);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
