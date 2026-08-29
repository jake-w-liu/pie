import { existsSync } from "node:fs";
import { DEFAULT_PACKAGE_SOURCES, getSettingsPath } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * Persist distribution package defaults only for a genuinely fresh user config.
 * Once settings.json exists, user removals and custom package choices remain authoritative.
 */
export async function seedDistributionDefaultPackages(
	settingsManager: SettingsManager,
	settingsPath = getSettingsPath(),
	defaultPackages: readonly string[] = DEFAULT_PACKAGE_SOURCES,
): Promise<boolean> {
	if (defaultPackages.length === 0 || existsSync(settingsPath)) return false;
	settingsManager.setPackages([...defaultPackages]);
	await settingsManager.flush();
	return true;
}
