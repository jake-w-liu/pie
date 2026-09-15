import { describe, expect, it } from "vitest";
import {
	exitCodeForSignal,
	rejectPendingExtensionRequests,
	toProtocolErrorMessage,
} from "../src/modes/rpc/rpc-mode.ts";

describe("audit rpc-mode helpers (L1/E5/L7)", () => {
	describe("L1: exitCodeForSignal", () => {
		it("maps SIGINT to 130 so Ctrl-C honors the cleanup path", () => {
			expect(exitCodeForSignal("SIGINT")).toBe(130);
		});

		it("keeps the existing SIGHUP/SIGTERM conventions", () => {
			expect(exitCodeForSignal("SIGHUP")).toBe(129);
			expect(exitCodeForSignal("SIGTERM")).toBe(143);
		});
	});

	describe("E5: toProtocolErrorMessage", () => {
		it("passes Error messages through", () => {
			expect(toProtocolErrorMessage(new Error("boom"))).toBe("boom");
		});

		it("stringifies non-Error rejections instead of reading .message", () => {
			expect(toProtocolErrorMessage("plain string")).toBe("plain string");
			expect(toProtocolErrorMessage(null)).toBe("null");
			expect(toProtocolErrorMessage(undefined)).toBe("undefined");
			expect(toProtocolErrorMessage(42)).toBe("42");
		});
	});

	describe("L7: rejectPendingExtensionRequests", () => {
		it("rejects every pending dialog and clears the map", async () => {
			const seen: string[] = [];
			const pending = new Map([
				["a", { resolve: () => {}, reject: (e: Error) => seen.push(`a:${e.message}`) }],
				["b", { resolve: () => {}, reject: (e: Error) => seen.push(`b:${e.message}`) }],
			]);
			rejectPendingExtensionRequests(pending, "Shutdown");
			expect(pending.size).toBe(0);
			expect(new Set(seen)).toEqual(new Set(["a:Shutdown", "b:Shutdown"]));
		});

		it("rejects awaiting editor() promises so shutdown never hangs on them", async () => {
			const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
			const gated = new Promise<string | undefined>((resolve, reject) => {
				pending.set("editor-1", { resolve: resolve as (v: unknown) => void, reject });
			});
			const assertion = expect(gated).rejects.toThrow("Shutdown");
			rejectPendingExtensionRequests(pending);
			await assertion;
			expect(pending.size).toBe(0);
		});

		it("drains the rest when one reject handler throws", () => {
			const drained: string[] = [];
			const pending = new Map([
				[
					"bad",
					{
						resolve: () => {},
						reject: () => {
							throw new Error("handler blew up");
						},
					},
				],
				["good", { resolve: () => {}, reject: () => drained.push("good") }],
			]);
			rejectPendingExtensionRequests(pending);
			expect(pending.size).toBe(0);
			expect(drained).toEqual(["good"]);
		});

		it("is a no-op for an empty map", () => {
			rejectPendingExtensionRequests(new Map());
		});
	});
});
