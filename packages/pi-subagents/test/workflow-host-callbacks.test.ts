/**
 * Host callbacks are invoked from inside the worker's "message" listener, so a
 * throw that escapes that listener is an uncaughtException in the agent process
 * rather than a workflow failure. Every callback in runWorkflowScript() is
 * invoked inside a promise chain for that reason; this pins the ones that were
 * not, plus the lifecycle guarantees that a throwing callback used to break.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../src/workflows/scripted-workflow.ts";
import type { RunWorkflowScriptOptions, WorkflowScriptChildResult } from "../src/workflows/scripted-workflow.ts";

const script = 'const s = await runs.status("a");\nreturn s.output;';

function harness(status: RunWorkflowScriptOptions["status"]): RunWorkflowScriptOptions {
	return {
		script,
		launch: async (key) => ({ key, ok: true, output: `out:${key}`, artifactPaths: [] }),
		status,
	};
}

const okResult: WorkflowScriptChildResult = { key: "a", ok: true, output: "out:a", artifactPaths: [] };

/**
 * An idle leaked worker keeps the host process alive but does not show up in
 * getActiveResourcesInfo, so the only honest way to assert the worker is gone is
 * to let a real process exit. The child writes a marker, prints DONE and must
 * exit on its own.
 */
function assertChildProcessExits(body: string, timeoutMs: number): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-workflow-leak-"));
	const file = join(directory, "child.ts");
	writeFileSync(file, [
		'import { runWorkflowScript } from ' + JSON.stringify(new URL("../src/workflows/scripted-workflow.ts", import.meta.url).href) + ";",
		"try {",
		"  await runWorkflowScript({",
		'    script: "return 1;",',
		"    launch: async (key) => ({ key, ok: true, output: 'o', artifactPaths: [] }),",
		"    status: async (key) => ({ key, ok: true, output: 'o', artifactPaths: [] }),",
		"    registerStopChild: () => { throw new Error('register exploded'); },",
		"  });",
		'  console.log("RESOLVED");',
		"} catch (error) {",
		'  console.log("REJECTED", error instanceof Error ? error.message : String(error));',
		"}",
		'console.log("DONE");',
		body,
	].join("\n"), "utf8");
	return execFileSync(process.execPath, [file], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
}

describe("workflowScript host callbacks stay contained", () => {
	it("surfaces a rejected status promise as a workflow error", async () => {
		await expect(runWorkflowScript(harness(async () => { throw new Error("status rejected"); }))).rejects.toThrow(/status rejected/);
	});

	it("surfaces a synchronous status throw as a workflow error instead of an uncaughtException", async () => {
		const thrown = ((): never => { throw new Error("status threw synchronously"); }) as RunWorkflowScriptOptions["status"];
		await expect(runWorkflowScript(harness(thrown))).rejects.toThrow(/status threw synchronously/);
		// The process survived the throw, so a later workflow still runs.
		const result = await runWorkflowScript(harness(async () => okResult));
		expect(result.value).toBe("out:a");
	}, 20_000);

	it("surfaces a throwing one-use permit claim as a rejected runs.run", async () => {
		const result = await runWorkflowScript({
			...harness(async () => okResult),
			script: 'try { await runs.run("a", { agent: "w", task: "A" }); } catch (error) { emit({ caught: error.message }); }\nreturn 1;',
			oneUsePermit: { claim: () => { throw new Error("claim exploded"); } },
		});
		expect(result.emits).toEqual([{ caught: "claim exploded" }]);
		expect(result.value).toBe(1);
	}, 20_000);

	it("reports a host value it cannot copy instead of dying on it", async () => {
		// Normalizing a host value walks it, and Object.entries invokes getters, so a
		// value with a throwing getter used to reject the floating response promise:
		// an unhandled rejection that takes the agent process down.
		const hostile = { get boom(): never { throw new Error("getter ran"); } };
		const result = await runWorkflowScript({
			...harness(async () => okResult),
			script: 'try { await state.get("k"); } catch (error) { emit({ caught: error.message }); }\nreturn 1;',
			state: { get: async () => hostile, set: async () => {} },
		});
		expect(result.emits).toEqual([{ caught: "Workflow could not copy the value returned by this call. getter ran" }]);
		expect(result.value).toBe(1);
	}, 20_000);
});

describe("workflowScript teardown survives a throwing host", () => {
	it("terminates the worker when the stop hook cannot be registered", async () => {
		await expect(
			runWorkflowScript({
				...harness(async () => okResult),
				registerStopChild: () => { throw new Error("register exploded"); },
			}),
		).rejects.toThrow(/register exploded/);
		// The worker was already running and nothing below can settle the promise after
		// this throw, so without the explicit terminate its thread outlives the
		// workflow and keeps the whole process alive.
		const output = assertChildProcessExits("", 20_000);
		expect(output).toContain("REJECTED register exploded");
		expect(output.trimEnd().endsWith("DONE")).toBe(true);
	}, 40_000);

	it("still settles when the stop hook cleanup throws", async () => {
		const result = await runWorkflowScript({
			...harness(async () => okResult),
			registerStopChild: (stop) => { if (!stop) throw new Error("cleanup exploded"); },
		});
		expect(result.value).toBe("out:a");
	}, 20_000);
});

describe("workflowScript reports a status call that never completed", () => {
	it("closes a journalled status entry when the host status fails", async () => {
		const result = await runWorkflowScript({
			...harness(async () => { throw new Error("status exploded"); }),
			script: 'try { await runs.status("probe"); } catch { emit({ caught: true }); }\nreturn 1;',
		});
		expect(result.value).toBe(1);
		expect(result.trace).toEqual([
			{ operation: "status", key: "probe", state: "started" },
			{ operation: "status", key: "probe", state: "failed", error: "status exploded" },
		]);
	}, 20_000);
});

describe("workflowScript results are final at settle time", () => {
	it("does not grow the returned trace or re-notify onTrace after resolving", async () => {
		const traces: unknown[][] = [];
		const result = await runWorkflowScript({
			script: [
				'const slow = runs.run("slow", { agent: "w", task: "S" });',
				"slow.then(() => {});",
				'const fast = await runs.run("fast", { agent: "w", task: "F" });',
				"return fast.output;",
			].join("\n"),
			launch: async (key) => {
				if (key !== "slow") return { key, ok: true, output: "out:fast", artifactPaths: [] };
				await new Promise((resolve) => setTimeout(resolve, 300));
				return { key, ok: true, output: "out:slow", artifactPaths: [] };
			},
			status: async (key) => ({ key, ok: true, output: "o", artifactPaths: [] }),
			onTrace: (trace) => traces.push(trace),
		});
		const traceAtSettle = [...result.trace];
		const notificationsAtSettle = traces.length;
		await new Promise((resolve) => setTimeout(resolve, 600));
		// A launch that settles after the workflow returned used to keep pushing into
		// the live arrays the caller already received, and re-persisted a finished
		// workflow through onTrace.
		expect(result.trace).toEqual(traceAtSettle);
		expect(traces.length).toBe(notificationsAtSettle);
	}, 20_000);
});

describe("workflowScript failure diagnostics never crash the host", () => {
	it("builds the return-serialization hint from a child result with no artifactPaths", async () => {
		// artifactPaths is required by the host contract, but this text is a diagnostic
		// built from host data while the workflow is already failing: reading it
		// unguarded threw a TypeError inside the worker message listener.
		await expect(
			runWorkflowScript({
				script: 'await runs.run("a", { agent: "w", task: "A" });\nreturn () => {};',
				launch: async (key) => ({ key, ok: true, output: "out:a" }) as unknown as Promise<WorkflowScriptChildResult>,
				status: async (key) => okResult,
			}),
		).rejects.toThrow(/Child work completed before return serialization failed/);
	}, 20_000);
});
