/**
 * The static checker and the worker's portability guard both parse the script as
 * "(async () => {\n<script>\n})()" and used to walk only the body of the FIRST
 * top-level statement. A script that closes that wrapper early and opens a second
 * async IIFE put the rest of itself in a second top-level statement, where no
 * check reached: its nested async functions ran and action:'validate' reported it
 * as valid. The error text also promises "no children launched", which was false.
 */
import { describe, expect, it } from "vitest";
import { runWorkflowScript, validateWorkflowScript } from "../src/workflows/scripted-workflow.ts";
import { claimWorkflowChildPermit, createWorkflowChildPermit, workflowChildPermitConsumed } from "../src/shared/workflow-child-permit.ts";
import type { RunWorkflowScriptOptions } from "../src/workflows/scripted-workflow.ts";

const harness = (script: string, overrides: Partial<RunWorkflowScriptOptions> = {}): RunWorkflowScriptOptions => ({
	script,
	launch: async (key) => ({ key, ok: true, output: `out:${key}`, artifactPaths: [] }),
	status: async (key) => ({ key, ok: true, output: "o", artifactPaths: [] }),
	...overrides,
});

/** Closes the injected wrapper and opens a second async IIFE. */
const split = (body: string): string => `return 1; } )(); (async () => { ${body} `;

describe("workflowScript validation reaches the whole program", () => {
	it("rejects a nested async function hidden in a second top-level statement", async () => {
		const script = split('const f = async () => runs.run("a", { agent: "w", task: "A" }); return (await f()).output;');
		expect(validateWorkflowScript(script).ok).toBe(false);
		expect(validateWorkflowScript(script).errors.map((error) => error.message)).toContain("workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains.");
		await expect(runWorkflowScript(harness(script))).rejects.toThrow(/no children launched/);
	});

	it("rejects an invalid runs.run key hidden in a second top-level statement", async () => {
		const script = split('const r = await runs.run("bad key!", { agent: "w", task: "A" }); return r.output;');
		expect(validateWorkflowScript(script).ok).toBe(false);
		await expect(runWorkflowScript(harness(script))).rejects.toThrow(/no children launched/);
	});

	it("still rejects the unsplit form", () => {
		expect(validateWorkflowScript('const f = async () => runs.run("a", { agent: "w", task: "A" });\nreturn (await f()).output;').ok).toBe(false);
	});

	it("still accepts ordinary scripts", () => {
		for (const script of [
			'const a = await runs.run("a", { agent: "w", task: "A" });\nreturn a.output;',
			'const [a] = await runs.all([{ key: "a", agent: "w", task: "A" }]);\nreturn a.output;',
			'function helper(x) { return x + 1; }\nreturn helper(1);',
			// A leading empty statement must not be mistaken for a split program.
			';const a = await runs.run("a", { agent: "w", task: "A" });\nreturn a.output;',
		]) {
			expect(validateWorkflowScript(script).errors, script).toEqual([]);
		}
	});
});

describe("workflowScript one-use permit survives an unsatisfiable call", () => {
	it("can still launch its permitted child after runs.all is refused", async () => {
		const permit = createWorkflowChildPermit({
			issuerPackage: "test",
			workflowRunId: "wf",
			childKey: "k",
			agent: "w",
			launchContractDigest: "digest",
			context: "fresh",
		} as never);
		const launched: string[] = [];
		const result = await runWorkflowScript(
			harness(
				[
					'try { await runs.all([{ key: "k", agent: "w", task: "A" }]); } catch (error) { emit({ refused: error.message }); }',
					'const r = await runs.run("k", { agent: "w", task: "A" });',
					"return r.output;",
				].join("\n"),
				{
					oneUsePermit: { claim: (key) => claimWorkflowChildPermit(permit, "wf", key) },
					launch: async (key) => { launched.push(key); return { key, ok: true, output: `out:${key}`, artifactPaths: [] }; },
				},
			),
		);
		expect(result.emits).toEqual([{ refused: "Workflow child permit does not support runs.all." }]);
		expect(result.value).toBe("out:k");
		expect(launched).toEqual(["k"]);
	}, 20_000);

	it("does not spend the permit on a retained resume the permit can never serve", async () => {
		const permit = createWorkflowChildPermit({
			issuerPackage: "test",
			workflowRunId: "wf",
			childKey: "k",
			agent: "w",
			launchContractDigest: "digest",
			context: "fresh",
		} as never);
		const result = await runWorkflowScript(
			harness(
				[
					'try { await runs.run("k", { resume: "run-x", task: "again" }); } catch (error) { emit({ refused: error.message }); }',
					"return 1;",
				].join("\n"),
				{ oneUsePermit: { claim: (key) => claimWorkflowChildPermit(permit, "wf", key) } },
			),
		);
		expect(result.emits).toEqual([{ refused: "Workflow child permit does not support retained resume." }]);
		// The single attempt is still available: claiming is irreversible, so refusing a
		// call that could never launch must not spend it.
		expect(workflowChildPermitConsumed(permit)).toBe(false);
	}, 20_000);
});
