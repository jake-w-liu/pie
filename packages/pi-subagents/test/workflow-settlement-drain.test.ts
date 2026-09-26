import { describe, expect, it } from "vitest";
import { WORKFLOW_SETTLEMENT_DRAIN_MS, WorkflowScriptError, runWorkflowScript } from "../src/workflows/scripted-workflow.ts";
import type { RunWorkflowScriptOptions, WorkflowScriptChildResult } from "../src/workflows/scripted-workflow.ts";

const fanoutScript = [
	'const a = runs.run("a", { agent: "worker", task: "A" });',
	'const b = runs.run("b", { agent: "worker", task: "B" });',
	"return await Promise.all([a, b]);",
].join("\n");

/** Launch that stays in flight until the workflow aborts it, then reports its run id. */
function abortedLaunch(runIdFor: (key: string) => string, onLaunch: (key: string) => void): NonNullable<RunWorkflowScriptOptions["launch"]> {
	return async (key, _params, signal): Promise<WorkflowScriptChildResult> => {
		onLaunch(key);
		await new Promise<void>((resolve) => {
			const onAbort = (): void => { setTimeout(resolve, 20); };
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		return { key, ok: false, runId: runIdFor(key), interrupted: true, output: "This operation was aborted", error: "This operation was aborted", artifactPaths: [] };
	};
}

function launchTracker(): { launched: (key: string) => void; allLaunched: (count: number) => Promise<void> } {
	const started = new Set<string>();
	let notify: (() => void) | undefined;
	const launched = (key: string): void => {
		started.add(key);
		if (started.size >= expected) notify?.();
	};
	let expected = 2;
	return {
		launched: (key: string) => launched(key),
		allLaunched: (count: number) => {
			expected = count;
			return started.size >= count ? Promise.resolve() : new Promise<void>((resolve) => { notify = resolve; });
		},
	};
}

async function expectWorkflowError(promise: Promise<unknown>): Promise<WorkflowScriptError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(WorkflowScriptError);
		return error as WorkflowScriptError;
	}
	throw new Error("expected runWorkflowScript to reject with a WorkflowScriptError");
}

const okStatus = async (key: string): Promise<WorkflowScriptChildResult> => ({ key, ok: true, output: "", artifactPaths: [] });

describe("workflow settlement on abort and timeout", () => {
	it("keeps the run ids of in-flight children that the abort drops", async () => {
		const controller = new AbortController();
		const tracker = launchTracker();
		const pending = runWorkflowScript({
			script: fanoutScript,
			signal: controller.signal,
			launch: abortedLaunch(() => "run-a", tracker.launched),
			status: okStatus,
		});
		await tracker.allLaunched(2);
		controller.abort(new Error("stop the workflow"));
		const error = await expectWorkflowError(pending);
		expect(error.message).toBe("stop the workflow");
		expect(error.partial.children.map((child) => [child.key, child.runId])).toEqual([["a", "run-a"], ["b", "run-a"]]);
	}, 20_000);

	it("keeps the run ids of in-flight children that the timeout drops", async () => {
		const tracker = launchTracker();
		const pending = runWorkflowScript({
			script: fanoutScript,
			timeoutMs: 3_000,
			launch: abortedLaunch((key) => `run-${key}`, tracker.launched),
			status: okStatus,
		});
		await tracker.allLaunched(2);
		const error = await expectWorkflowError(pending);
		expect(error.errorKind).toBe("timeout");
		expect(error.partial.children.map((child) => [child.key, child.runId])).toEqual([["a", "run-a"], ["b", "run-b"]]);
	}, 20_000);

	it("stays bounded when a steer host never settles, so abort still decides the outcome", async () => {
		const controller = new AbortController();
		const tracker = launchTracker();
		let steerRequested!: () => void;
		const steerArrived = new Promise<void>((resolve) => { steerRequested = resolve; });
		const started = Date.now();
		const pending = runWorkflowScript({
			script: 'const a = runs.run("a", { agent: "worker", task: "A" });\nawait runs.steer("a", "keep going");\nreturn await a;',
			signal: controller.signal,
			launch: abortedLaunch(() => "run-a", tracker.launched),
			status: okStatus,
			steer: () => {
				steerRequested();
				return new Promise<never>(() => {});
			},
		});
		await tracker.allLaunched(1);
		await steerArrived;
		controller.abort(new Error("stop the workflow"));
		const error = await expectWorkflowError(pending);
		expect(error.message).toBe("stop the workflow");
		expect(Date.now() - started).toBeLessThan(WORKFLOW_SETTLEMENT_DRAIN_MS + 5_000);
		expect(error.partial.children.map((child) => [child.key, child.runId])).toEqual([["a", "run-a"]]);
	}, 30_000);
});
