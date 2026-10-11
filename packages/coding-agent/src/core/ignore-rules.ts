import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type ignore from "ignore";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	const anchored = pattern.startsWith("/");
	if (anchored) pattern = pattern.slice(1);
	const withoutTrailingSlash = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
	const descendantPattern = prefix && !anchored && !withoutTrailingSlash.includes("/") ? `**/${pattern}` : pattern;
	const prefixed = prefix ? `${prefix}${descendantPattern}` : descendantPattern;
	return negated ? `!${prefixed}` : prefixed;
}

export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) ig.add(patterns);
		} catch {}
	}
}
