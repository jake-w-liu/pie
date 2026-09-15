/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	copyFileSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { stripBom } from "./utils/text.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Existing credentials are preserved and win on conflict. An empty, missing,
	// or unparseable auth.json is treated as "no credentials yet" so a prior
	// interrupted migration can be retried instead of blocking oauth recovery
	// forever; unparseable files are backed up for manual repair first.
	let existing: Record<string, unknown> = {};
	if (existsSync(authPath)) {
		try {
			const parsed: unknown = JSON.parse(stripBom(readFileSync(authPath, "utf-8")));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			} else {
				throw new Error("auth.json is not an object");
			}
		} catch {
			try {
				renameSync(authPath, `${authPath}.corrupt-${Date.now()}`);
			} catch {
				return [];
			}
			existing = {};
		}
	}

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];
	let consumedOauth = false;
	let settingsNeedsStrip = false;

	// Collect oauth.json credentials (in memory only for now).
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			consumedOauth = true;
		} catch {
			// Skip on error
		}
	}

	// Collect settings.json apiKeys (in memory only for now).
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				settingsNeedsStrip = true;
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length === 0) return providers;

	// Only providers not already in auth.json count as newly migrated.
	const newlyMigrated = providers.filter((provider) => !(provider in existing));

	// Persist auth.json BEFORE removing the legacy sources, so a crash between
	// the two steps duplicates credentials instead of losing them.
	mkdirSync(dirname(authPath), { recursive: true });
	writeFileSync(authPath, JSON.stringify({ ...migrated, ...existing }, null, 2), { mode: 0o600 });

	if (consumedOauth) {
		try {
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// The credentials are safe in auth.json; the stale oauth.json will be
			// re-merged (not duplicated) on the next run.
		}
	}

	if (settingsNeedsStrip) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			delete settings.apiKeys;
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
		} catch {
			// The credentials are safe in auth.json; stripping is retried next run.
		}
	}

	return newlyMigrated;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) {
				// Never strand the source silently: identical content means the
				// migration already happened, so drop the duplicate; divergent
				// content is preserved under a unique name.
				try {
					const sourceContent = readFileSync(file);
					const targetContent = readFileSync(newPath);
					if (sourceContent.equals(targetContent)) {
						rmSync(file);
						continue;
					}
				} catch {
					// Fall through to the uniquified move below.
				}
				const duplicatePath = findAvailablePath(correctDir, `${fileName}.duplicate`);
				moveSessionFile(file, duplicatePath);
				console.log(
					chalk.yellow(
						`Session migration: ${fileName} already exists in ${safePath}; moved divergent copy to ${duplicatePath.split("/").pop()}`,
					),
				);
				continue;
			}

			moveSessionFile(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Move a session file, falling back to copy+delete when the source and target
 * live on different devices (EXDEV, e.g. a symlinked agent dir).
 */
function moveSessionFile(source: string, target: string): void {
	try {
		renameSync(source, target);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
	}
	copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
	rmSync(source);
}

/** Find a non-existing path by appending a numeric suffix. */
function findAvailablePath(dir: string, baseName: string): string {
	let candidate = join(dir, baseName);
	for (let n = 1; existsSync(candidate); n++) {
		candidate = join(dir, `${baseName}-${n}`);
	}
	return candidate;
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
