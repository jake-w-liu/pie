import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSubagentGuide, SUBAGENT_GUIDE_TOPICS } from "../../pi-subagents/src/extension/subagent-guide.ts";

const packageRoot = fileURLToPath(new URL("../../pi-subagents/", import.meta.url));

describe("packaged subagent guides", () => {
	let installedRoot: string;

	beforeAll(() => {
		installedRoot = mkdtempSync(join(tmpdir(), "pie-subagent-guides-"));
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files: string[] };
		for (const entry of manifest.files) {
			cpSync(join(packageRoot, entry), join(installedRoot, entry), { recursive: true });
		}
	});

	afterAll(() => rmSync(installedRoot, { recursive: true, force: true }));

	for (const topic of SUBAGENT_GUIDE_TOPICS) {
		it(`reads ${topic} from shipped assets without a source checkout`, () => {
			const guide = readSubagentGuide(topic, installedRoot);
			expect(guide).toMatch(/# Pi Subagents/);
			expect(guide).toEqual(readSubagentGuide(topic, packageRoot));
		});
	}

	it("uses the overview by default", () => {
		expect(readSubagentGuide(undefined, installedRoot)).toEqual(readSubagentGuide("overview", installedRoot));
	});

	it("rejects unknown topics before reading arbitrary paths", () => {
		expect(readSubagentGuide("../../package.json", installedRoot)).toContain("Unknown subagents guide topic");
	});

	it("reports missing assets rather than silently substituting unrelated help", () => {
		expect(() => readSubagentGuide("workflows", join(installedRoot, "missing"))).toThrow(
			"Failed to read packaged subagents guide 'workflows'",
		);
	});
});
