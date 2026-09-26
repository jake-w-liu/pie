import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createInteractiveHarness } from "./tui-audit-helpers.ts";

/**
 * The TUI leaves stdin in raw mode with the cursor hidden and the alt screen
 * active, so a crash that skips the terminal restore makes the shell unusable
 * until `stty sane && reset`. shutdown() sets isShuttingDown before it touches
 * the terminal, so the crash window overlaps the whole teardown.
 */
describe("uncaught crash terminal restore", () => {
	const cleanups: (() => void)[] = [];
	const spies: Array<{ mockRestore(): void }> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		for (const spy of spies.splice(0)) spy.mockRestore();
		vi.restoreAllMocks();
	});

	async function setup() {
		const harness = await createInteractiveHarness();
		cleanups.push(harness.cleanup);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);
		spies.push(exit);
		return { ...harness, exit };
	}

	function crash(mode: InteractiveMode): void {
		Reflect.get(mode, "uncaughtCrash").call(mode, new Error("boom"));
	}

	it("restores the terminal when the crash lands inside the shutdown window", async () => {
		const { mode, tui } = await setup();
		const stop = vi.spyOn(tui, "stop");
		// shutdown() flips this before the restore runs, so it is true for the
		// whole drainInput/dispose window.
		Reflect.set(mode, "isShuttingDown", true);

		expect(() => crash(mode)).toThrow("process.exit");
		expect(stop).toHaveBeenCalled();
	});

	it("restores the terminal when no shutdown is in progress", async () => {
		const { mode, tui } = await setup();
		const stop = vi.spyOn(tui, "stop");

		expect(() => crash(mode)).toThrow("process.exit");
		expect(stop).toHaveBeenCalled();
	});

	it("is idempotent when the shutdown already restored the terminal", async () => {
		const { mode, tui } = await setup();
		const stop = vi.spyOn(tui, "stop");
		Reflect.set(mode, "isShuttingDown", true);
		tui.stop();
		stop.mockClear();

		expect(() => crash(mode)).toThrow("process.exit");
		expect(stop).toHaveBeenCalled();
	});

	it("skips the restore once the terminal is known to be gone", async () => {
		const { mode, tui } = await setup();
		const stop = vi.spyOn(tui, "stop");
		// emergencyTerminalExit established that restore writes would re-raise
		// EIO; that deliberate decision must not leak into the normal path.
		Reflect.set(mode, "terminalUnrestorable", true);

		expect(() => crash(mode)).toThrow("process.exit");
		expect(stop).not.toHaveBeenCalled();
	});
});
