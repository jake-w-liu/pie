import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";

/**
 * Auto-discovery expands `pi.extensions` from a package.json. Entries must stay
 * inside that package: the identical expansion in package-manager.ts rejects
 * escaping entries, and the loader-side copy did not, so the SDK discovery path
 * could import any readable file as an extension.
 */
describe("extension discovery containment", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pie-ext-containment-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("ignores manifest entries that resolve outside the package root", async () => {
		const pkgDir = join(root, "pkg");
		const agentDir = join(root, "agent");
		mkdirSync(pkgDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		// A file outside the package, reachable only through a `..` entry.
		writeFileSync(join(root, "payload.ts"), "export default function () {}\n");
		writeFileSync(join(pkgDir, "inside.ts"), "export default function () {}\n");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "traversal", pi: { extensions: ["../payload.ts", "./inside.ts"] } }),
		);

		const result = await discoverAndLoadExtensions([pkgDir], root, agentDir);
		const loaded = result.extensions.map((extension) => extension.path);

		expect(loaded).toContain(join(pkgDir, "inside.ts"));
		expect(loaded).not.toContain(join(root, "payload.ts"));
	});

	it("ignores an absolute manifest entry", async () => {
		const pkgDir = join(root, "pkg");
		const agentDir = join(root, "agent");
		mkdirSync(pkgDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const outside = join(root, "outside.ts");
		writeFileSync(outside, "export default function () {}\n");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "abs", pi: { extensions: [outside] } }));

		const result = await discoverAndLoadExtensions([pkgDir], root, agentDir);

		expect(result.extensions.map((extension) => extension.path)).not.toContain(outside);
	});
});
