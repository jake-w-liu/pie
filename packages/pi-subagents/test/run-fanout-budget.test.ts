import { describe, expect, it } from "vitest";
import {
	claimRunFanoutBatch,
	claimRunFanoutBatchWithReceipt,
	createRunFanoutBudget,
	getRunFanoutBudgetSnapshot,
	releaseRunFanoutBatch,
} from "../src/runs/shared/run-fanout-budget.ts";

describe("B5: rejected launches release their fan-out claims", () => {
	it("claim -> release restores budget for sibling launches", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 2);
		const receipt = claimRunFanoutBatchWithReceipt(budget, ["tasks[0]", "tasks[1]"]);
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(2);

		// Simulate a post-claim rejection (e.g. spawn-budget reserve failure).
		releaseRunFanoutBatch(budget, receipt);
		const snapshot = getRunFanoutBudgetSnapshot(budget);
		expect(snapshot.used).toBe(0);
		expect(snapshot.remaining).toBe(2);
	});

	it("release is scoped to the released paths", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 3);
		claimRunFanoutBatch(budget, ["tasks[0]"]);
		const receipt = claimRunFanoutBatchWithReceipt(budget, ["tasks[1]"]);
		releaseRunFanoutBatch(budget, receipt);
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(1);
	});

	it("releases only the receipted admission when a logical path is reused", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 3);
		claimRunFanoutBatch(budget, ["single"]);
		const receipt = claimRunFanoutBatchWithReceipt(budget, ["single"]);
		releaseRunFanoutBatch(budget, receipt);
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(1);
	});

	it("release of nothing is a safe no-op", () => {
		const budget = createRunFanoutBudget(`test-${Date.now()}`, 1);
		expect(() => releaseRunFanoutBatch(budget, { claimIds: [] })).not.toThrow();
		expect(() => releaseRunFanoutBatch(budget, { claimIds: ["missing"] })).not.toThrow();
		expect(getRunFanoutBudgetSnapshot(budget).used).toBe(0);
	});
});
