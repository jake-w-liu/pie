import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markModelCatalogOutput, replaceModelCatalogOutput } from "../scripts/owned-output-directory.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-catalog-output-"));
	roots.push(root);
	const target = join(root, "target");
	const staged = join(root, "staged");
	mkdirSync(target);
	mkdirSync(staged);
	writeFileSync(join(target, "sentinel"), "keep");
	writeFileSync(join(staged, "models.json"), "{}\n");
	markModelCatalogOutput(staged);
	return { target, staged };
}

describe("owned model catalog output", () => {
	it("refuses to replace an unowned directory without deleting it", () => {
		const { target, staged } = fixture();
		expect(() => replaceModelCatalogOutput(target, staged, false)).toThrow("unowned JSON output directory");
		expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
	});

	it("replaces a marked output directory", () => {
		const { target, staged } = fixture();
		markModelCatalogOutput(target);
		replaceModelCatalogOutput(target, staged, false);
		expect(existsSync(join(target, "models.json"))).toBe(true);
		expect(existsSync(join(target, "sentinel"))).toBe(false);
	});
});
