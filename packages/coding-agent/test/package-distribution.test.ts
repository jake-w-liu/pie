import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	version: string;
	bin: { pie: string };
	piConfig: { configDir: string; defaultPackages: string[] };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { import: string; types: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;
const aiPackageJson = JSON.parse(readFileSync(new URL("../../ai/package.json", import.meta.url), "utf8")) as {
	version: string;
};

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		// Pie restarts at 0.x and bumps every package in lockstep (scripts/bump-version.mjs).
		expect(packageJson.version).toMatch(/^0\.\d+\.\d+$/);
		expect(packageJson.version).toBe(aiPackageJson.version);
		expect(packageJson.bin).toEqual({ pie: "dist/bundle/pie-cli.js" });
		expect(packageJson.piConfig).toEqual({
			configDir: ".pi",
			// The pi-web-access / pi-subagents extensions are now vendored into
			// the release (as @earendil-works/pi-ext-*) and auto-discovered from the
			// coding-agent's node_modules, so defaultPackages no longer pulls them from
			// the npm registry.
			defaultPackages: [],
		});
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./client"].import).toBe("./dist/client/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});
});
