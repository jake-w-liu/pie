/**
 * Proof that the workflowScript vm context no longer hands the script a
 * worker-realm object.
 *
 * The escape this closes: the context used to be seeded with worker-realm values
 * (runs, emit, console, state, Promise), so `runs.run.constructor` was the worker
 * realm's `Function`. `codeGeneration.strings: false` only governs code compiled
 * inside the context, so that host Function could still be called to reach the
 * worker realm and from there `process`, `require`, and the filesystem.
 *
 * The context is now created empty and the API is installed from inside it, so
 * `.constructor` yields the context realm's own Function.
 */
import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../src/workflows/scripted-workflow.ts";
import type { RunWorkflowScriptOptions, WorkflowScriptChildResult } from "../src/workflows/scripted-workflow.ts";

const okResult = async (key: string): Promise<WorkflowScriptChildResult> => ({ key, ok: true, output: `out:${key}`, artifactPaths: [] });

function harness(overrides: Partial<RunWorkflowScriptOptions> = {}): RunWorkflowScriptOptions {
	return {
		script: "return 1;",
		launch: async (key) => okResult(key),
		status: async (key) => okResult(key),
		...overrides,
	};
}

/** Run a probe script and return whatever it managed to produce. */
async function probe(script: string): Promise<unknown> {
	const result = await runWorkflowScript(harness({ script }));
	return result.value;
}

describe("workflowScript context isolation", () => {
	it("refuses to build a Function from the context realm", async () => {
		await expect(probe('return typeof runs.run.constructor("return process")();')).rejects.toThrow(
			/Code generation from strings disallowed|process is not defined/,
		);
	});

	it("cannot reach process through any injected global's constructor chain", async () => {
		for (const expression of [
			'runs.run.constructor("return process")()',
			'runs.all.constructor("return process")()',
			"console.log.constructor('return process')()",
			"emit.constructor('return process')()",
		]) {
			await expect(probe(`return ${expression};`)).rejects.toThrow();
		}
	});

	it("cannot reach require or the filesystem through the global object", async () => {
		for (const expression of ["typeof require", "typeof process", "typeof globalThis.process", "typeof module"]) {
			const result = await probe(`return ${expression};`);
			expect(result).toBe("undefined");
		}
	});

	it("exposes no host-realm prototype to walk", async () => {
		// A context-realm object has the context's Object.prototype, whose
		// constructor chain stops inside the context.
		const result = await probe("return Object.getPrototypeOf(runs) === Object.prototype ? 'context' : 'foreign';");
		expect(result).toBe("context");
	});

	it("still runs ordinary workflows", async () => {
		const result = await probe(
			[
				'const a = await runs.run("a", { agent: "worker", task: "A" });',
				'const b = await runs.run("b", { agent: "worker", task: "B" });',
				"return [a.output, b.output];",
			].join("\n"),
		);
		expect(result).toEqual(["out:a", "out:b"]);
	});

	it("adopts host results into the context realm", async () => {
		// The result the script sees must be a context-realm object: stringifying it
		// through the constructor chain must not surface the host realm.
		const result = await probe(
			[
				'const r = await runs.run("a", { agent: "worker", task: "A" });',
				"return { output: r.output, proto: Object.getPrototypeOf(r) === Object.prototype };",
			].join("\n"),
		);
		expect(result).toEqual({ output: "out:a", proto: true });
	});

	it("keeps runs.all an ordered array and rejects key access", async () => {
		const ordered = await probe(
			[
				'const results = await runs.all([{ key: "a", agent: "worker", task: "A" }, { key: "b", agent: "worker", task: "B" }]);',
				"return [Array.isArray(results), results.length, results[0].output, results[1].output];",
			].join("\n"),
		);
		expect(ordered).toEqual([true, 2, "out:a", "out:b"]);

		await expect(
			probe(
				[
					'const results = await runs.all([{ key: "a", agent: "worker", task: "A" }]);',
					"return results.a;",
				].join("\n"),
			),
		).rejects.toThrow(/resolves to an ordered array, not a key map/);
	});

	it("surfaces a host failure as a context-realm error", async () => {
		await expect(
			runWorkflowScript(
				harness({
					script: 'const r = await runs.run("a", { agent: "worker", task: "A" }); return r.output;',
					launch: async () => {
						throw new Error("launch exploded");
					},
				}),
			),
		).rejects.toThrow(/launch exploded/);
	});

	it("routes emit and console through the host", async () => {
		const result = await runWorkflowScript(
			harness({
				script: ['emit({ note: "hi" });', 'console.log("from script");', "return 7;"].join("\n"),
			}),
		);
		expect(result.value).toBe(7);
		expect(result.emits).toEqual([{ note: "hi" }]);
		expect(result.console).toEqual([{ level: "log", text: "from script" }]);
	});

	it("round-trips workflow state through the host", async () => {
		const store = new Map<string, unknown>();
		const result = await runWorkflowScript(
			harness({
				script: [
					'await state.set("k", { n: 1 });',
					'const back = await state.get("k");',
					"return back;",
				].join("\n"),
				state: {
					get: async (key) => store.get(key),
					set: async (key, value) => {
						store.set(key, value);
					},
				},
			}),
		);
		expect(result.value).toEqual({ n: 1 });
		expect(store.get("k")).toEqual({ n: 1 });
	});

	it("exposes a context-realm Promise that tracks the script's awaits", async () => {
		const result = await probe(
			[
				'const p = runs.run("a", { agent: "worker", task: "A" });',
				"const [r] = await Promise.all([p]);",
				"return r.output;",
			].join("\n"),
		);
		expect(result).toBe("out:a");
	});

	it("cannot reach the host global through the instrumented Promise.prototype.then", async () => {
		// The instrumentation that tracks launch consumption is installed ON the
		// context's Promise.prototype. Defining it from the worker realm put a
		// worker-realm function there, and codeGeneration.strings:false does not guard
		// the host Function constructor, so this reached process/require.
		for (const expression of [
			'Promise.prototype.then.constructor("return this")().process',
			'Promise.prototype.then.constructor("return require")("node:fs")',
			'runs.run.constructor("return process")()',
		]) {
			await expect(probe(`return ${expression};`)).rejects.toThrow();
		}
	});

	it("keeps the instrumented then a context-realm function", async () => {
		const result = await probe(
			[
				"return {",
				"  thenIsContext: Promise.prototype.then.constructor === Function,",
				"  thenProtoIsContext: Object.getPrototypeOf(Promise.prototype.then.constructor) === Function.prototype,",
				"};",
			].join("\n"),
		);
		expect(result).toEqual({ thenIsContext: true, thenProtoIsContext: true });
	});

	it("carries a runs.all result array back to the host through emit", async () => {
		const result = await runWorkflowScript(
			harness({
				script: [
					'const results = await runs.all([{ key: "a", agent: "worker", task: "A" }, { key: "b", agent: "worker", task: "B" }]);',
					"emit(results);",
					"return 1;",
				].join("\n"),
			}),
		);
		expect(result.value).toBe(1);
		expect(result.emits).toEqual([
			[
				expect.objectContaining({ key: "a", output: "out:a" }),
				expect.objectContaining({ key: "b", output: "out:b" }),
			],
		]);
	});

	it("carries a runs.all result array back to the host through state.set", async () => {
		const store = new Map<string, unknown>();
		const result = await runWorkflowScript(
			harness({
				script: [
					'const results = await runs.all([{ key: "a", agent: "worker", task: "A" }]);',
					'await state.set("k", results);',
					"return 1;",
				].join("\n"),
				state: {
					get: async (key) => store.get(key),
					set: async (key, value) => {
						store.set(key, value);
					},
				},
			}),
		);
		expect(result.value).toBe(1);
		expect(store.get("k")).toEqual([expect.objectContaining({ key: "a", output: "out:a" })]);
	});

	it("keeps a run result's toString live rather than frozen at adopt time", async () => {
		const result = await probe(
			[
				'const r = await runs.run("a", { agent: "worker", task: "A" });',
				"r.output = 'changed';",
				"return `${r}`;",
			].join("\n"),
		);
		expect(result).toBe("changed");
	});

	it("still flags a launch the script never awaits", async () => {
		// The consumption relay exists so an awaited launch is not misreported as
		// unawaited. This pins the other direction: a genuinely unawaited launch must
		// still be detected, or the relay would be marking everything consumed.
		await expect(
			probe(['runs.run("a", { agent: "worker", task: "A" });', "return 1;"].join("\n")),
		).rejects.toThrow(/unawaited runs\.run launch\(es\): 'a'/);
	});
});
