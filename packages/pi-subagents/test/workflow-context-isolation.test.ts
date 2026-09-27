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

	it("cannot reach the host realm through any name the global inherits", async () => {
		// Node's contextified global inherits from the sandbox object's prototype
		// chain. With an ordinary {} sandbox that chain was the worker realm's
		// Object.prototype, so each inherited name below yielded the worker realm's
		// UNRESTRICTED Function - codeGeneration.strings:false only governs the
		// context's own Function - and from there require, the filesystem and a
		// shell were reachable. Every route has to be covered: blocking only
		// "constructor" left the other seven open.
		for (const expression of [
			"globalThis.constructor.constructor('return typeof process')()",
			"globalThis.valueOf.constructor('return typeof process')()",
			"globalThis.toString.constructor('return typeof process')()",
			"globalThis.hasOwnProperty.constructor('return typeof process')()",
			"globalThis.isPrototypeOf.constructor('return typeof process')()",
			"globalThis.propertyIsEnumerable.constructor('return typeof process')()",
			"globalThis.toLocaleString.constructor('return typeof process')()",
			"globalThis.globalThis.constructor.constructor('return typeof process')()",
			"this.constructor.constructor('return typeof process')()",
			"globalThis.__proto__.constructor.constructor('return typeof process')()",
			"Object.getPrototypeOf(globalThis).constructor.constructor('return typeof process')()",
			"Object.getPrototypeOf(Object.getPrototypeOf(globalThis)).constructor.constructor('return typeof process')()",
			"globalThis.constructor.constructor(\"return require('node:fs').readFileSync('/etc/hosts', 'utf8').length > 0\")()",
			"globalThis.constructor.constructor(\"return require('node:child_process').execSync('echo ESCAPED').toString().trim()\")()",
		]) {
			// Every route throws in the script: either the context's own Function
			// refuses to build from a string, or the name is gone entirely.
			await expect(probe(`return ${expression};`), expression).rejects.toThrow();
		}
	}, 30_000);

	it("keeps code generation from strings disabled in the context's own Function", async () => {
		// Isolation must come from the sandbox shape, not from switching the guard off.
		await expect(probe("return typeof Function('return 1')();")).rejects.toThrow(/Code generation from strings disallowed/);
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

	it("keeps a host payload's own __proto__ key as data, not as a prototype", async () => {
		// JSON.parse produces an own "__proto__" data key, and mission state reaches the
		// worker as exactly that. Adopting it with copy[key] = ... hit the inherited
		// __proto__ setter, so the copy lost the key and inherited the payload instead.
		const store = new Map<string, unknown>([["evil", JSON.parse('{"__proto__":{"polluted":"yes"},"ok":1}')]]);
		const result = await runWorkflowScript(
			harness({
				script: [
					'const v = await state.get("evil");',
					"return {",
					"  own: Object.getOwnPropertyNames(v),",
					"  protoIsObject: Object.getPrototypeOf(v) === Object.prototype,",
					"  inherited: v.polluted,",
					"};",
				].join("\n"),
				state: { get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) },
			}),
		);
		expect(result.value).toEqual({ own: ["__proto__", "ok"], protoIsObject: true, inherited: undefined });
	});

	it("returns a host payload that carries its own __proto__ key", async () => {
		// The prototype swap also made the adopted value non-JSON, so returning it
		// failed the return serializer with "must contain only plain JSON objects".
		const store = new Map<string, unknown>([["evil", JSON.parse('{"__proto__":{"polluted":"yes"},"ok":1}')]]);
		const result = await runWorkflowScript(
			harness({
				script: ['const v = await state.get("evil");', "return v;"].join("\n"),
				state: { get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) },
			}),
		);
		expect(JSON.stringify(result.value)).toBe('{"__proto__":{"polluted":"yes"},"ok":1}');
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

	it("reads an out-of-range index on a runs.all result as undefined", async () => {
		// The guard is rebuilt inside the vm context from installWorkflowApi.toString(),
		// so its index test has to read the same after a re-parse. A double-escaped
		// digit class matched only "0", and every other index fell through to the
		// key-map error instead of the undefined a real array read returns.
		const outOfRange = await probe(
			[
				'const results = await runs.all([{ key: "a", agent: "worker", task: "A" }]);',
				"return [results[1], results[99]];",
			].join("\n"),
		);
		expect(outOfRange).toEqual([null, null]);
		const emptyIndex = await probe(["const results = await runs.all([]);", "return results[0];"].join("\n"));
		expect(emptyIndex).toBeNull();
		// A key-shaped read is still the actionable error it documents.
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

	it("reports a self-referencing emit as a cycle instead of overflowing the stack", async () => {
		// Unwrapping the runs.all guard before the JSON check never recorded plain
		// objects it was visiting, so a script-built cycle recursed until the stack gave
		// out and the failure named stack exhaustion instead of the cycle.
		for (const [name, script] of [
			["direct", "const o = { a: 1 }; o.self = o; emit(o); return 1;"],
			["mutual", "const a = {}; const b = { a }; a.b = b; emit(a); return 1;"],
			["through a runs.all result", 'const r = await runs.all([{ key: "a", agent: "w", task: "A" }]); const o = { r }; o.self = o; emit(o); return 1;'],
		] as const) {
			await expect(runWorkflowScript(harness({ script })), name).rejects.toThrow(/must not contain cycles/);
		}
	}, 30_000);

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

/**
 * A host call that throws SYNCHRONOUSLY must not hand the script a worker-realm
 * Error. toContextPromise only converts async failures, because it hooks .then;
 * `toContextPromise(host.runs.run(key, params))` evaluated that call first, so a
 * sync throw escaped raw and `e.constructor.constructor` gave the script a live
 * worker Function that reaches process.
 *
 * Each case below provokes a real synchronous host throw on a different entry
 * point and asserts the caught value is a context-realm Error that cannot build a
 * Function.
 */
const SYNC_THROW_PROBES: Array<{ name: string; script: string }> = [
	{ name: "emit(undefined) -> host assertJsonValue", script: "try { emit(undefined); } catch (e) { REPORT(e); }" },
	{ name: "state.set(bad key) -> host validateStateKey", script: 'try { await state.set("!!", 1); } catch (e) { REPORT(e); }' },
	{ name: "runs.run(non-string key) -> host validateRunCall", script: 'try { await runs.run(42, { agent: "worker", task: "A" }); } catch (e) { REPORT(e); }' },
	{ name: "runs.all(non-array) -> host check", script: 'try { await runs.all("nope"); } catch (e) { REPORT(e); }' },
	{ name: "runs.steer(bad mode) -> host validate", script: 'try { await runs.steer("a", "hi", { mode: "bogus" }); } catch (e) { REPORT(e); }' },
];

function escapeProbe(body: string): string {
	return [
		"function REPORT(e) {",
		"  let reach = 'no-error';",
		"  try { reach = e.constructor.constructor('return typeof process')(); }",
		"  catch (inner) { reach = 'blocked'; }",
		"  emit({ isContextError: e instanceof Error, escape: reach });",
		"}",
		body,
		"return 1;",
	].join("\n");
}

describe("workflowScript synchronous host throws stay in the context realm", () => {
	for (const { name, script } of SYNC_THROW_PROBES) {
		it(`converts ${name} into a context-realm error`, async () => {
			const result = await runWorkflowScript(
				harness({ script: escapeProbe(script) }),
			);
			const reported = result.emits?.[0] as { isContextError?: boolean; escape?: string } | undefined;
			expect(reported, "the probe should have caught a host throw").toBeDefined();
			expect(reported?.isContextError, "a worker-realm Error reached the script").toBe(true);
			// "object" would mean the host realm is reachable; anything else is blocked.
			expect(reported?.escape, "the script reached the host realm's Function").not.toBe("object");
		}, 20_000);
	}

	it("does not leak the host realm through a synchronous ref failure", async () => {
		const result = await runWorkflowScript(
			harness({ script: escapeProbe('try { runs.ref(undefined); } catch (e) { REPORT(e); }') }),
		);
		const reported = result.emits?.[0] as { isContextError?: boolean; escape?: string } | undefined;
		expect(reported?.isContextError).toBe(true);
		expect(reported?.escape).not.toBe("object");
	}, 20_000);
});
