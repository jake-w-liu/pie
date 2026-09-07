import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createTestExtensionsResult } from "./utilities.ts";

/**
 * fff, subagents, and web-access are core pie functionality, not optional
 * extensions: they must always ship and load. The former `.pi/extensions`
 * helpers (import-repro, prompt-url-widget, redraws, tps) are likewise
 * built in so no user-local copies are needed.
 */
describe("built-in extensions", () => {
	it("always includes the core capabilities and ported helpers", () => {
		const names = builtInExtensions.map((entry) => (typeof entry === "function" ? "<anonymous>" : entry.name));
		for (const expected of [
			"fff",
			"subagents",
			"web-access",
			"import-repro",
			"prompt-url-widget",
			"redraws",
			"tps",
		]) {
			expect(names).toContain(expected);
		}
	});

	it("exposes a callable factory for every entry", () => {
		for (const entry of builtInExtensions) {
			const factory = typeof entry === "function" ? entry : entry.factory;
			expect(typeof factory).toBe("function");
		}
	});
});

describe("built-in extension loading", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("loads the ported helpers and lazily-loaded core capabilities without errors", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-builtin-ext-"));
		const wanted = new Set(["fff", "subagents", "web-access", "import-repro", "prompt-url-widget", "redraws", "tps"]);
		const inputs = builtInExtensions.filter(
			(entry): entry is Extract<typeof entry, { name: string }> =>
				typeof entry !== "function" && wanted.has(entry.name),
		);
		expect(inputs.map((entry) => entry.name).sort()).toEqual([...wanted].sort());

		const result = await createTestExtensionsResult(inputs, tempDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(inputs.length);

		const commands = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
		// Spot-check registrations from each built-in: fff, subagents, web-access,
		// import-repro, redraws. (prompt-url-widget and tps register widgets and
		// event handlers, which have no command surface to assert on.)
		for (const expected of ["fff-features", "ir", "tui", "websearch"]) {
			expect(commands).toContain(expected);
		}
		const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
		expect(tools).toContain("subagent");
		expect(tools).toContain("web_search");
	}, 120_000);
});
