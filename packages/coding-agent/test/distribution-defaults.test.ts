import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDistributionDefaultPackages } from "../src/core/distribution-defaults.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const shippedPackages = ["npm:pi-fff@0.1.12", "npm:pi-web-access@0.26.0", "npm:pi-subagents@0.58.0"] as const;

describe("distribution package defaults", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("persists pinned package defaults for a fresh settings file", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-default-packages-"));
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		const manager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });

		await expect(seedDistributionDefaultPackages(manager, settingsPath, shippedPackages)).resolves.toBe(true);
		expect(existsSync(settingsPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ packages: shippedPackages });
	});

	it("never overwrites an existing settings file, so removals survive restarts", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-existing-packages-"));
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:custom-package"] }));
		const manager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });

		await expect(seedDistributionDefaultPackages(manager, settingsPath, shippedPackages)).resolves.toBe(false);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ packages: ["npm:custom-package"] });
	});
});
