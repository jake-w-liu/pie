import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * Resolve the pi-web-access config path using the same precedence as the extension
 * (packages/coding-agent ships `npm:pi-web-access`, which reads this file per call).
 */
export function getWebSearchConfigPath(): string {
	if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi", "web-search.json");
	return join(homedir(), ".pi", "web-search.json");
}

/**
 * Seed terminal-only web search defaults (no browser curator, no approval prompt) for a
 * genuinely fresh config. A shipped Pie install should not pop a browser by default; once
 * web-search.json exists, the user's own settings remain authoritative.
 */
export function seedDistributionWebSearchDefaults(webSearchPath = getWebSearchConfigPath()): boolean {
	if (existsSync(webSearchPath)) return false;
	mkdirSync(dirname(webSearchPath), { recursive: true });
	writeFileSync(webSearchPath, JSON.stringify({ workflow: "auto-summary", autoOpenBrowser: false }, null, 2) + "\n");
	return true;
}
