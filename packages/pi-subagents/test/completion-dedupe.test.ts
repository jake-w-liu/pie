import { describe, expect, it } from "vitest";
import { buildCompletionKey, markSeenWithTtl } from "../src/runs/background/completion-dedupe.ts";

describe("B15: completion-dedupe key normalizes terminal state spellings", () => {
	it("treats 'complete' and 'completed' as the same completion", () => {
		const base = { sessionId: "s1", id: "run-1" };
		expect(buildCompletionKey({ ...base, state: "complete" }, "notify")).toBe(
			buildCompletionKey({ ...base, state: "completed" }, "notify"),
		);
	});

	it("still distinguishes different runs and states", () => {
		expect(buildCompletionKey({ sessionId: "s1", id: "a", state: "complete" }, "notify")).not.toBe(
			buildCompletionKey({ sessionId: "s1", id: "b", state: "completed" }, "notify"),
		);
		expect(buildCompletionKey({ sessionId: "s1", id: "a", state: "failed" }, "notify")).not.toBe(
			buildCompletionKey({ sessionId: "s1", id: "a", state: "completed" }, "notify"),
		);
	});

	it("dedupes across spelling variants via markSeenWithTtl", () => {
		const seen = new Map<string, number>();
		const first = buildCompletionKey({ sessionId: "s1", id: "run-1", state: "complete" }, "notify");
		const second = buildCompletionKey({ sessionId: "s1", id: "run-1", state: "completed" }, "notify");
		expect(markSeenWithTtl(seen, first, Date.now(), 60_000)).toBe(false);
		expect(markSeenWithTtl(seen, second, Date.now(), 60_000)).toBe(true);
	});
});
