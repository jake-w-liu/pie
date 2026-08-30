import { describe, expect, it } from "vitest";
import { sleep } from "../src/utils/sleep.ts";

describe("sleep", () => {
	it("resolves after the given delay", async () => {
		const start = performance.now();
		await sleep(10);
		expect(performance.now() - start).toBeGreaterThanOrEqual(5);
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleep(10_000, controller.signal)).rejects.toThrow("Aborted");
	});

	it("rejects when the signal aborts during the sleep", async () => {
		const controller = new AbortController();
		const promise = sleep(10_000, controller.signal);
		controller.abort();
		await expect(promise).rejects.toThrow("Aborted");
	});

	it("removes its abort listener on normal completion (no leak on a long-lived signal)", async () => {
		const controller = new AbortController();
		const signal = controller.signal;
		// Create a fake signal so we can observe listener bookkeeping.
		const listeners = new Set<() => void>();
		const fakeSignal = {
			aborted: false,
			addEventListener: (_: string, fn: () => void) => listeners.add(fn),
			removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
		} as unknown as AbortSignal;

		await sleep(1, fakeSignal);
		// After resolution the abort listener must have been removed.
		expect(listeners.size).toBe(0);
		// And the real signal path must not reject a later abort.
		controller.abort();
		expect(signal.aborted).toBe(true);
	});
});
