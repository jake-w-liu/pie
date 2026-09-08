import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function parseNpmPackResult(output, manifest) {
	let parsed;
	try {
		parsed = JSON.parse(output);
	} catch (cause) {
		throw new Error(`Invalid npm pack result for ${manifest.name}`, { cause });
	}
	// npm supports both an array and an object keyed by package name.
	const results = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
	const packed = results.length === 1 ? results[0] : undefined;
	if (!packed || packed.name !== manifest.name || typeof packed.filename !== "string" ||
		!packed.filename || basename(packed.filename) !== packed.filename || !Array.isArray(packed.files) ||
		!packed.files.every((file) => file && typeof file.path === "string")) {
		throw new Error(`Invalid npm pack result for ${manifest.name}`);
	}

	const entrypoints = new Set(["package.json"]);
	function collectEntrypoints(value) {
		if (typeof value === "string") entrypoints.add(value.replace(/^\.\//, ""));
		else if (value && typeof value === "object") {
			for (const target of Object.values(value)) collectEntrypoints(target);
		}
	}
	if (manifest.exports !== undefined) collectEntrypoints(manifest.exports);
	else {
		collectEntrypoints(manifest.main);
		collectEntrypoints(manifest.types);
	}
	collectEntrypoints(manifest.bin);
	collectEntrypoints(manifest.pi?.extensions);
	for (const entrypoint of entrypoints) {
		// Export wildcards substitute subpaths, including nested directories.
		const pattern = new RegExp(`^${entrypoint.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		if (!packed.files.some((file) => pattern.test(file.path))) {
			throw new Error(`${manifest.name}: packed files omit declared entrypoint ${entrypoint}`);
		}
	}
	return packed;
}

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
