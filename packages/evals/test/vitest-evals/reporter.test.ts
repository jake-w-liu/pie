import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { TestCase, TestModule, Vitest } from "vitest/node";
import { normalizeHarnessRun } from "vitest-evals/harness";
import { EVAL_HARNESS_ITERATION_ARTIFACT } from "../../src/vitest-evals/harness-table.ts";
import EvalHarnessReporter from "../../src/vitest-evals/reporter.ts";

function report(
	state: ReturnType<TestCase["result"]>["state"],
	score: number | undefined,
	thresholdFailed?: boolean,
	errors = false,
): string {
	const tests = ["baseline", "candidate"].map((name) => {
		const run = normalizeHarnessRun("input", {
			output: "ok",
			events: [{ type: "message", role: "assistant", content: "ok" }],
			usage: { totalTokens: 100 },
		});
		run.artifacts = {
			[EVAL_HARNESS_ITERATION_ARTIFACT]: {
				schemaVersion: 1,
				evalSet: "classification",
				groupKey: "input",
				harness: name,
				baseline: "baseline",
				candidates: ["candidate"],
				repetition: 1,
			},
		};
		if (errors && name === "candidate") run.errors = [{ message: "Harness failed" }];
		const meta: ReturnType<TestCase["meta"]> = {
			harness: { name, run },
			...(score === undefined && name === "candidate"
				? {}
				: {
						eval: { scores: [], avgScore: name === "baseline" ? 1 : score!, thresholdFailed },
					}),
		};
		return {
			name: "case",
			meta: () => meta,
			result: () => ({ state: name === "baseline" ? "passed" : state }),
		} as unknown as TestCase;
	});
	const module = { relativeModuleId: "fixture.eval.ts", children: { allTests: () => tests } } as unknown as TestModule;
	const log = vi.fn<(message: string) => void>();
	const reporter = new EvalHarnessReporter();
	reporter.onInit({ logger: { log } } as unknown as Vitest);
	reporter.onTestRunEnd([module], [], state === "failed" ? "failed" : "passed");
	return stripVTControlCharacters(log.mock.calls[0][0]);
}

describe("eval observation classification", () => {
	it.each([false, undefined])("excludes a scored run with a failed hard invariant (threshold flag %s)", (flag) => {
		const output = report("failed", 1, flag);
		expect(output).toContain("candidate (0/1 pairs)");
		expect(output).toContain("harness-error:");
		expect(output).toContain("Tokens  unavailable");
	});

	it.each(["passed", "failed"] as const)("retains low judge scores when test state is %s", (state) => {
		const output = report(state, 0, state === "failed");
		expect(output).toContain("candidate (1/1 pairs)");
		expect(output).toContain("Pass rate  -100.0 pp");
		expect(output).not.toContain("Incomplete observations");
	});

	it("does not let threshold metadata mask harness execution errors", () => {
		expect(report("failed", 0, true, true)).toContain("harness-error:");
	});

	it.each(["skipped", "pending"] as const)("does not score a %s test with stale score metadata", (state) => {
		const output = report(state, 1);
		expect(output).toContain("candidate (0/1 pairs)");
		expect(output).toContain("unscorable-outcome:");
	});

	it("keeps absent scores distinct from failures", () => {
		expect(report("passed", undefined)).toContain("missing-score:");
		expect(report("failed", undefined)).toContain("harness-error:");
	});
});
