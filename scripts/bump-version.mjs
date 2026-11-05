#!/usr/bin/env node
/**
 * Bump every workspace package to the next patch version in lockstep and regenerate
 * the files that record it: internal dependency ranges, package-lock.json, the
 * coding-agent shrinkwrap and install lock, and the README version line.
 *
 * Usage: node scripts/bump-version.mjs
 *
 * Run from the repository root. Prints the new version as the last stdout line.
 * Does not commit, tag, or push; scripts/refresh-pie.sh does that for local refreshes.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages, removeStaleWorkspaceLockEntries } from "./release-packages.mjs";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const README_VERSION_PATTERN = /(\*\*Pie version:\*\* `)\d+\.\d+\.\d+(`)/;

/** Next patch version of a plain `major.minor.patch` version. */
export function nextPatchVersion(version) {
	const match = VERSION_PATTERN.exec(version);
	if (!match) throw new Error(`Expected a major.minor.patch version, found ${JSON.stringify(version)}`);
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** README text with its "Pie version" line set to `version`; unchanged when the line is absent. */
export function updateReadmeVersion(text, version) {
	return text.replace(README_VERSION_PATTERN, `$1${version}$2`);
}

function readVersion(packageJsonPath) {
	return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

function run(command, args) {
	// Progress goes to stderr so stdout carries only the final version.
	execFileSync(command, args, { stdio: ["ignore", 2, 2] });
}

function main() {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const codingAgentPackage = join("packages", "coding-agent", "package.json");
	const currentVersion = readVersion(codingAgentPackage);
	const expectedVersion = nextPatchVersion(currentVersion);

	run(npm, ["version", "patch", "--workspaces", "--no-git-tag-version", "--no-workspaces-update"]);
	// Validates lockstep versions and moves internal dependency ranges to the new version.
	run(process.execPath, [join("scripts", "sync-versions.js")]);
	run(npm, ["install", "--package-lock-only", "--ignore-scripts"]);
	if (removeStaleWorkspaceLockEntries() > 0) {
		run(npm, ["install", "--package-lock-only", "--ignore-scripts"]);
	}
	run(process.execPath, [join("scripts", "generate-coding-agent-shrinkwrap.mjs")]);
	run(process.execPath, [join("scripts", "generate-coding-agent-install-lock.mjs")]);

	const newVersion = readVersion(codingAgentPackage);
	if (newVersion !== expectedVersion) {
		throw new Error(`Expected ${codingAgentPackage} at ${expectedVersion} after the bump, found ${newVersion}`);
	}
	const stale = getPublicWorkspacePackages().filter((pkg) => pkg.version !== newVersion);
	if (stale.length > 0) {
		throw new Error(
			`Packages not at ${newVersion} after the bump: ${stale.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
		);
	}

	const readmePath = "README.md";
	const readme = readFileSync(readmePath, "utf8");
	const updatedReadme = updateReadmeVersion(readme, newVersion);
	if (updatedReadme !== readme) writeFileSync(readmePath, updatedReadme);

	process.stdout.write(`${newVersion}\n`);
}

// Run only as a script, so tests can import the pure helpers.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	main();
}
