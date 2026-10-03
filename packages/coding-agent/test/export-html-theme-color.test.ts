import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";

const DARK_THEME = new URL("../src/modes/interactive/theme/dark.json", import.meta.url);

/**
 * Theme colors are user data and are interpolated into a `<style>` raw-text
 * element, where HTML escaping does not apply. A color value that can close the
 * style block would execute when the exported document is opened.
 */
describe("export HTML theme color injection", () => {
	let scratch: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "export-theme-color-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
		mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "themes"), { recursive: true });
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(scratch, { recursive: true, force: true });
	});

	function writeTheme(overrides: Record<string, string | number>): void {
		const theme = JSON.parse(readFileSync(DARK_THEME, "utf-8"));
		theme.name = "injection-test";
		Object.assign(theme.colors, overrides);
		writeFileSync(join(scratch, "agent", "themes", "injection-test.json"), JSON.stringify(theme));
	}

	function writeSession(): string {
		const session = join(scratch, "session.jsonl");
		writeFileSync(
			session,
			`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2025-01-01T00:00:00Z", cwd: scratch })}\n`,
		);
		return session;
	}

	it("refuses a theme color that can close the style element", async () => {
		writeTheme({ accent: "#fff;} </style><script>globalThis.PWNED=1</script><style> :root{--x:red" });
		const outputPath = join(scratch, "out.html");

		await expect(exportFromFile(writeSession(), { outputPath, themeName: "injection-test" })).rejects.toThrow(
			/not a valid CSS color/,
		);
	});

	it("still exports a theme whose colors are valid CSS colors", async () => {
		// Hex strings and 256-color palette indexes are the forms theme resolution
		// produces; the derived export colors are `rgb(...)` literals.
		writeTheme({ accent: "#abcdef", border: 33 });
		const outputPath = join(scratch, "out.html");

		await exportFromFile(writeSession(), { outputPath, themeName: "injection-test" });
		const html = readFileSync(outputPath, "utf-8");
		expect(html).toContain("--accent: #abcdef;");
		expect(html).toContain("--border: #0087ff;");
		expect(html).toMatch(/--exportPageBg: (#[0-9a-f]{6}|rgb\([^)]*\));/);
	});
});
