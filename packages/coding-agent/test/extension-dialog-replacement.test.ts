import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInteractiveHarness } from "./tui-audit-helpers.ts";

/**
 * An extension dialog opened while another one is still up supersedes it. The
 * superseded component used to be dropped without dispose(), so its countdown
 * interval kept driving requestRender() for the rest of the session and, worse,
 * eventually fired the cancel callback that tears down whichever dialog happened
 * to be open by then.
 */
describe("extension dialog replacement", () => {
	const liveIntervals = new Set<ReturnType<typeof setInterval>>();
	let realSetInterval: typeof globalThis.setInterval;
	let realClearInterval: typeof globalThis.clearInterval;

	function trackIntervals(): void {
		realSetInterval = globalThis.setInterval;
		realClearInterval = globalThis.clearInterval;
		globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			const handle = realSetInterval(handler, timeout, ...args);
			liveIntervals.add(handle as unknown as ReturnType<typeof setInterval>);
			return handle;
		}) as typeof globalThis.setInterval;
		globalThis.clearInterval = ((handle: unknown) => {
			liveIntervals.delete(handle as unknown as ReturnType<typeof setInterval>);
			return realClearInterval(handle as unknown as ReturnType<typeof setInterval>);
		}) as typeof globalThis.clearInterval;
	}

	beforeEach(trackIntervals);

	afterEach(() => {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
		for (const handle of liveIntervals) realClearInterval(handle);
		liveIntervals.clear();
		vi.useRealTimers();
	});

	it("disposes the superseded input dialog's countdown interval", async () => {
		const harness = await createInteractiveHarness();
		try {
			// Neither dialog is answered; the second simply replaces the first.
			const first = harness.context.input("first", undefined, { timeout: 600_000 });
			const second = harness.context.input("second", undefined, { timeout: 600_000 });
			void first;
			void second;

			expect(liveIntervals.size).toBe(1);
		} finally {
			harness.cleanup();
		}
	}, 30_000);

	it("disposes the superseded selector's countdown interval", async () => {
		const harness = await createInteractiveHarness();
		try {
			const first = harness.context.select("first", ["a", "b"], { timeout: 600_000 });
			const second = harness.context.select("second", ["a", "b"], { timeout: 600_000 });
			void first;
			void second;

			expect(liveIntervals.size).toBe(1);
		} finally {
			harness.cleanup();
		}
	}, 30_000);
});
