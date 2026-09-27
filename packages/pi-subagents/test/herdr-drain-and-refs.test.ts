import { describe, expect, it } from "vitest";
import { registerHerdrStatusBridge } from "../src/integrations/herdr-status.ts";
import type { HerdrStatusBridgeOptions, HerdrStatusRun } from "../src/integrations/herdr-status.ts";
import { runWorkflowScript } from "../src/workflows/scripted-workflow.ts";
import type { WorkflowScriptChildResult } from "../src/workflows/scripted-workflow.ts";

describe("runs.refs", () => {
	it("returns a formatted string for a results array, like runs.ref", async () => {
		const launch = async (key: string): Promise<WorkflowScriptChildResult> => ({
			key,
			ok: true,
			runId: `run-${key}`,
			output: "",
			artifactPaths: [],
		});
		const status = async (key: string): Promise<WorkflowScriptChildResult> => ({
			key,
			ok: true,
			runId: `run-${key}`,
			output: "",
			artifactPaths: [],
		});

		const result = await runWorkflowScript({
			script: 'const rs = await runs.all([{ key: "a", agent: "worker", task: "A" }, { key: "b", agent: "worker", task: "B" }]);\nreturn { single: runs.ref(rs[0]), many: runs.refs(rs) };',
			launch,
			status,
		});

		// runs.refs joins formatRef over the array; it returns a string, not a promise.
		const value = result.value as { single: string; many: string };
		expect(value.single).toContain("run-a");
		expect(value.many).toContain("run-a");
		expect(value.many).toContain("run-b");
		expect(value.many.split("\n")).toHaveLength(2);
	});

	it("still rejects a non-array argument", async () => {
		await expect(
			runWorkflowScript({
				script: 'return { many: runs.refs("not-an-array") };',
				launch: async (key) => ({ key, ok: true, output: "", artifactPaths: [] }),
				status: async (key) => ({ key, ok: true, output: "", artifactPaths: [] }),
			}),
		).rejects.toThrow(/requires an array/);
	});
});

function bridgeHarness(overrides: Partial<HerdrStatusBridgeOptions> = {}): {
	reports: string[][];
	bridge: ReturnType<typeof registerHerdrStatusBridge>;
} {
	const reports: string[][] = [];
	const options: HerdrStatusBridgeOptions = {
		events: { on: () => () => {}, emit: () => {} },
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1" },
		runHerdr: (args) => {
			reports.push([...args]);
		},
		...overrides,
	};
	return { reports, bridge: registerHerdrStatusBridge(options) };
}

const run: HerdrStatusRun = { id: "run-1", agent: "worker" };

describe("herdr status drain", () => {
	it("flush() always settles and keeps the event loop turning across interleaved publishes", async () => {
		// COVERAGE NOTE: this asserts the flush() contract, not the specific
		// microtask race that was fixed. It passes against the unfixed code too,
		// because the window (enqueue landing after the drain loop's
		// `while (pendingReport)` check goes false but before `.finally()` clears
		// `draining`) is not reachable deterministically from the public API. The
		// fix was validated by side-by-side execution of the patched and unpatched
		// module (unpatched: report dropped, flush() never settles, macrotask
		// probe never fires; patched: report delivered, flush() resolves). A
		// deterministic regression test for that interleaving is still open.
		for (let attempt = 0; attempt < 40; attempt++) {
			let reports = 0;
			// Bound the feedback: runHerdr re-publishes a fixed number of times per
			// attempt, otherwise the bridge (correctly) publishes on every state
			// change and the test loop never terminates.
			let republishes = 0;
			const maxRepublishes = 2;
			let bridgeRef: ReturnType<typeof registerHerdrStatusBridge> | undefined;
			const bridge = registerHerdrStatusBridge({
				events: { on: () => () => {}, emit: () => {} },
				env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1" },
				getRuns: () => [run],
				runHerdr: () => {
					reports++;
					if (republishes >= maxRepublishes) return;
					republishes++;
					// Vary the microtask depth so the re-publish lands at a
					// different point relative to the drain loop each attempt.
					for (let i = 0; i < attempt % 4; i++) queueMicrotask(() => {});
					queueMicrotask(() => bridgeRef?.syncRuns());
				},
			});
			bridgeRef = bridge;
			bridge.sessionStarted({ hasUI: true, runs: [run] });

			const settled = await new Promise<boolean>((resolve) => {
				// A macrotask that must still run proves the loop was not starved.
				const timer = setTimeout(() => resolve(false), 2000);
				bridge.flush().then(
					() => {
						clearTimeout(timer);
						resolve(true);
					},
					() => {
						clearTimeout(timer);
						resolve(false);
					},
				);
			});

			expect(settled, `flush() hung on attempt ${attempt}`).toBe(true);
			expect(reports, `a publish was dropped on attempt ${attempt}`).toBeGreaterThanOrEqual(1);
			bridge.dispose();
		}
	}, 60_000);

	it("flush() terminates instead of spinning when work is stranded", async () => {
		const { reports, bridge } = bridgeHarness({ getRuns: () => [run] });
		bridge.sessionStarted({ hasUI: true, runs: [run] });
		bridge.syncRuns();
		await Promise.resolve();

		// A macrotask that must still run proves the event loop is not starved.
		const macrotaskRan = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(true), 20);
			bridge.flush().then(
				() => {
					clearTimeout(timer);
					resolve(true);
				},
				() => {
					clearTimeout(timer);
					resolve(false);
				},
			);
		});

		expect(macrotaskRan).toBe(true);
		expect(reports.length).toBeGreaterThan(0);
		bridge.dispose();
	}, 10_000);
});
