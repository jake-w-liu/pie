import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-ext-subagents";

/**
 * Resolve the installed pi-ext-subagents package root.
 *
 * Sources inside this package read bundled assets (agents/, prompts/,
 * skills/) and spawn helper entry points (subagent-runner.ts, extension
 * modules) relative to the package root. `import.meta.url` works when modules
 * execute from their real files (dev, tests, jiti-loaded extensions), but
 * points at the application bundle once the host inlines this package.
 * Resolving through the installed package location keeps those paths working
 * in every runtime; the relative fallback preserves behavior when the package
 * is executed outside an installed tree.
 */
export function getPackageRoot(): string {
	try {
		const require = createRequire(import.meta.url);
		return path.dirname(require.resolve(PACKAGE_NAME));
	} catch {
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	}
}
