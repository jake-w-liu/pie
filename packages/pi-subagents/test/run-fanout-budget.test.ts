import { describe, expect, it } from "vitest";
import {
	claimRunFanoutBatch,
	createRunFanoutBudget,
	getRunFanoutBudgetSnapshot,
	releaseRunFanoutBatch,
} from "../src/runs/shared/run-fanout-budget.ts";

describe("B5: rejected launches release their fan-out claims", () => {
	it("claim -> release restores budget for sibling launches", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 2);
		claimRunFanoutBatch(budget, ["tasks[0]", "tasks[1]"]);
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(2);

		// Simulate a post-claim rejection (e.g. spawn-budget reserve failure).
		releaseRunFanoutBatch(budget, ["tasks[0]", "tasks[1]"]);
		const snapshot = getRunFanoutBudgetSnapshot(budget);
		expect(snapshot.used).toBe(0);
		expect(snapshot.remaining).toBe(2);
	});

	it("release is scoped to the released paths", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 3);
		claimRunFanoutBatch(budget, ["tasks[0]", "tasks[1]"]);
		releaseRunFanoutBatch(budget, ["tasks[0]"]);
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(1);
	});

	it("release of nothing is a safe no-op", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 1);
		expect(() => releaseRunFanoutBatch(budget, [])).not.toThrow();
		expect(() => releaseRunFanoutBatch(budget, ["tasks[9]"])).not.toThrow();
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(0);
	});
});
