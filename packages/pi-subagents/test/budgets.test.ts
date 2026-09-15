import { describe, expect, it } from "vitest";
import { sumResultsCost } from "../src/shared/utils.ts";
import type { SingleResult } from "../src/shared/types.ts";
import { toolBudgetBlockedMessage, normalizeToolBudgetBlock, shouldBlockToolForBudget } from "../src/runs/shared/tool-budget.ts";
import { turnBudgetDecision } from "../src/runs/shared/turn-budget.ts";
import { usageBudgetExceededMessage, usageBudgetState } from "../src/runs/shared/usage-budget.ts";

function singleResult(usage: Partial<SingleResult["usage"]>): SingleResult {
	return {
		index: 0,
		agent: "test",
		task: "test",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, ...usage },
	};
}

describe("B1: turn-budget deferral is bounded", () => {
	const budget = { maxTurns: 1, graceTurns: 1 };

	it("continues before the hard limit", () => {
		expect(turnBudgetDecision(budget, 1, false, true)).toBe("continue");
	});

	it("defers at the hard limit while tool work is active", () => {
		expect(turnBudgetDecision(budget, 2, false, true)).toBe("defer");
	});

	it("aborts past the hard limit plus another grace window despite tool work", () => {
		// hardLimit = 2; deferral extension = 1 more grace window (turn 3).
		expect(turnBudgetDecision(budget, 3, false, true)).toBe("defer");
		expect(turnBudgetDecision(budget, 4, false, true)).toBe("abort");
		expect(turnBudgetDecision(budget, 100, false, true)).toBe("abort");
	});

	it("aborts at the hard limit when no tool work is active", () => {
		expect(turnBudgetDecision(budget, 2, false, false)).toBe("abort");
	});

	it("enforceHardLimit aborts at the hard limit even with tool work", () => {
		expect(turnBudgetDecision(budget, 2, false, true, true)).toBe("abort");
	});

	it("a terminal assistant stop always continues (run ends on its own)", () => {
		expect(turnBudgetDecision(budget, 50, true, true)).toBe("continue");
	});
});

describe("B2: tool-budget hard limit blocks unlisted tools by default", () => {
	it("defaults to blocking every tool", () => {
		expect(normalizeToolBudgetBlock(undefined)).toBe("*");
	});

	it("blocks an unlisted tool past the hard limit under the default", () => {
		const budget = { hard: 2, block: normalizeToolBudgetBlock(undefined) };
		expect(shouldBlockToolForBudget(budget, "bash", 3)).toBe(true);
		expect(shouldBlockToolForBudget(budget, "read", 3)).toBe(true);
	});

	it("does not block at or below the hard limit", () => {
		const budget = { hard: 2, block: normalizeToolBudgetBlock(undefined) };
		expect(shouldBlockToolForBudget(budget, "bash", 2)).toBe(false);
		expect(shouldBlockToolForBudget(budget, "bash", 1)).toBe(false);
	});

	it("still honors an explicit scoped block list", () => {
		const budget = { hard: 2, block: normalizeToolBudgetBlock(["read"]) };
		expect(shouldBlockToolForBudget(budget, "read", 3)).toBe(true);
		expect(shouldBlockToolForBudget(budget, "bash", 3)).toBe(false);
	});

	it("block message still matches the parent-side detection substring", () => {
		expect(toolBudgetBlockedMessage({ hard: 2, block: "*" }, "bash", 3)).toContain("Tool budget hard limit reached");
	});
});

describe("B4: usage budget counts cache tokens", () => {
	it("sums cache tokens in sumResultsCost", () => {
		const total = sumResultsCost([singleResult({ input: 5, output: 5, cacheRead: 100, cacheWrite: 50 })]);
		expect(total.inputTokens).toBe(5);
		expect(total.outputTokens).toBe(5);
		expect(total.cacheReadTokens).toBe(100);
		expect(total.cacheWriteTokens).toBe(50);
	});

	it("exhausts a token budget on cache tokens alone", () => {
		const state = usageBudgetState(
			{ tokens: { hard: 10 } },
			{ inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: 1_000_000 },
		);
		expect(state?.exhausted).toBe(true);
		expect(state?.reason).toBe("tokens");
		expect(usageBudgetExceededMessage(state!)).toContain("reported tokens");
	});

	it("stays within budget when all tokens fit", () => {
		const state = usageBudgetState(
			{ tokens: { hard: 100 } },
			{ inputTokens: 10, outputTokens: 10, costUsd: 0, cacheReadTokens: 10, cacheWriteTokens: 5 },
		);
		expect(state?.exhausted).toBe(false);
		expect(state?.tokens?.used).toBe(35);
	});
});
