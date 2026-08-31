#!/usr/bin/env node
/**
 * Precise, whitespace-tolerant file patching for AI coding workflows.
 *
 * Why: the builtin edit tool requires byte-exact `oldText` matches (tabs vs
 * spaces, trailing whitespace, line endings), so reconstructed snippets often
 * fail, costing tokens (failed edit + re-read + retry). This helper:
 *   1. Tries an EXACT match first.
 *   2. Falls back to a whitespace-tolerant regex match (`\s+` for any run),
 *      but only applies when the match is UNIQUE (never guess).
 *   3. Reports clear success / not-found / ambiguous, with a preview.
 *
 * Usage: node scripts/patch-file.mjs <spec.json>
 *   spec.json: { "file": string, "old": string, "new": string,
 *                "all"?: boolean, "tolerant"?: boolean }
 *   - "all": replace every occurrence (still requires at least one).
 *   - otherwise: require exactly one occurrence (exact or tolerant).
 *   - "tolerant": skip the exact pass and go straight to whitespace-tolerant.
 */
import { readFileSync, writeFileSync } from "node:fs";

function main() {
	const specPath = process.argv[2];
	if (!specPath) {
		console.error("usage: node scripts/patch-file.mjs <spec.json>");
		process.exit(2);
	}
	let spec;
	try {
		spec = JSON.parse(readFileSync(specPath, "utf8"));
	} catch (error) {
		console.error(`cannot read spec ${specPath}: ${error.message}`);
		process.exit(2);
	}
	const { file, old, new: replacement, all = false, tolerant = false } = spec;
	if (!file || typeof old !== "string" || typeof replacement !== "string") {
		console.error("spec requires {file, old, new}");
		process.exit(2);
	}

	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch (error) {
		console.error(`cannot read ${file}: ${error.message}`);
		process.exit(1);
	}

	// 1) Exact pass.
	let count = 0;
	if (!tolerant) {
		if (all) {
			const split = content.split(old);
			count = split.length - 1;
			if (count > 0) content = split.join(replacement);
		} else {
			const idx = content.indexOf(old);
			if (idx !== -1) {
				const idx2 = content.indexOf(old, idx + 1);
				if (idx2 === -1) {
					count = 1;
					content = content.slice(0, idx) + replacement + content.slice(idx + old.length);
				} else {
					console.error("AMBIGUOUS: multiple exact matches; use \"all\":true or a more specific \"old\".");
					process.exit(1);
				}
			}
		}
	}

	// 2) Whitespace-tolerant fallback (exact found nothing).
	if (count === 0) {
		const re = new RegExp(toTolerantRegex(old), "g");
		const matches = [...content.matchAll(re)];
		if (matches.length === 0) {
			console.error("NOT FOUND: no exact or whitespace-tolerant match.");
			process.exit(1);
		}
		if (!all && matches.length > 1) {
			console.error(`AMBIGUOUS: ${matches.length} whitespace-tolerant matches; use "all":true or a more specific "old".`);
			process.exit(1);
		}
		// Replace from the end to keep earlier indices valid.
		for (let i = matches.length - 1; i >= 0; i--) {
			const m = matches[i];
			content = content.slice(0, m.index) + replacement + content.slice(m.index + m[0].length);
		}
		count = matches.length;
	}

	writeFileSync(file, content);
	console.log(`OK: replaced ${count} occurrence(s) in ${file}`);
}

/** Escape regex specials but allow whitespace runs to match any run. */
function toTolerantRegex(text) {
	let out = "";
	for (const ch of text) {
		if (/\s/.test(ch)) {
			if (!out.endsWith("\\s+")) out += "\\s+";
			continue;
		}
		out += /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
	}
	return out;
}

main();
