import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	version: string;
	bin: { pi: string; pie: string };
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

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.version).toBe("0.1.0");
		expect(packageJson.bin.pi).toBe("dist/bundle/cli.js");
		expect(packageJson.bin.pie).toBe("dist/bundle/pie-cli.js");
		expect(packageJson.piConfig).toEqual({
			configDir: ".pi",
			// The pi-fff / pi-web-access / pi-subagents extensions are now vendored into
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
