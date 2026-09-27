import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-changelog-"));
const after = [];
afterEach(() => {
	for (const dir of after.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function writeChangelog(body) {
	const dir = mkdtempSync(join(root, "pkg-"));
	after.push(dir);
	writeFileSync(join(dir, "CHANGELOG.md"), body, "utf-8");
	return join(dir, "CHANGELOG.md");
}

/** Mirrors the fixed rewrite in scripts/release.mjs. */
function updateChangelogsForRelease(path, version, date = "2026-09-27") {
	const content = readFileSync(path, "utf-8");
	if (!content.includes("## [Unreleased]")) return { skipped: true };
	const headings = content.match(/^## \[Unreleased\]$/gm) ?? [];
	if (headings.length !== 1) {
		throw new Error(
			`${path} has ${headings.length} "## [Unreleased]" headings; exactly one is required before releasing.`,
		);
	}
	writeFileSync(path, content.replace("## [Unreleased]", `## [${version}] - ${date}`));
	return { skipped: false };
}

/** Mirrors the fixed addUnreleasedSection in scripts/release.mjs. */
function addUnreleasedSection(path) {
	const content = readFileSync(path, "utf-8");
	if (content.includes("## [Unreleased]")) return { added: false };
	const updated = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
	if (updated === content) {
		throw new Error(`${path} does not start with a "# Changelog" heading; cannot add an [Unreleased] section.`);
	}
	writeFileSync(path, updated);
	return { added: true };
}

describe("release changelog rewrite", () => {
	it("replaces the single [Unreleased] heading and carries its entries into the version section", () => {
		const path = writeChangelog("# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed a thing.\n\n## [0.1.0] - 2026-01-01\n");
		updateChangelogsForRelease(path, "0.2.0");
		const after = readFileSync(path, "utf-8");
		assert.match(after, /## \[0\.2\.0\] - 2026-09-27\n\n### Fixed\n\n- Fixed a thing\./);
		assert.equal((after.match(/^## \[Unreleased\]$/gm) ?? []).length, 0);
	});

	it("refuses to rewrite a changelog with a duplicated [Unreleased] heading", () => {
		// This is the exact shape packages/server/CHANGELOG.md had: a real release
		// sequence plus a second [Unreleased] stranded below a released version.
		const path = writeChangelog(
			"# Changelog\n\n## [Unreleased]\n\n## [0.84.3] - 2026-08-24\n\n## [0.84.2] - 2026-08-14\n\n## [Unreleased]\n\n### Fixed\n\n- Real entry.\n",
		);
		assert.throws(() => updateChangelogsForRelease(path, "0.85.0"), /exactly one is required/);
		// The file is untouched, so nothing is silently lost.
		assert.match(readFileSync(path, "utf-8"), /- Real entry\./);
	});

	it("adds an [Unreleased] section only when the file is missing one", () => {
		const withSection = writeChangelog("# Changelog\n\n## [0.1.0] - 2026-01-01\n");
		assert.equal(addUnreleasedSection(withSection).added, true);
		assert.match(readFileSync(withSection, "utf-8"), /^# Changelog\n\n## \[Unreleased\]\n\n## \[0\.1\.0\]/);

		// Second call is a no-op rather than a duplicate heading.
		assert.equal(addUnreleasedSection(withSection).added, false);
		assert.equal((readFileSync(withSection, "utf-8").match(/^## \[Unreleased\]$/gm) ?? []).length, 1);
	});

	it("fails instead of silently doing nothing when the anchor heading is missing", () => {
		const path = writeChangelog("<h1>Release notes</h1>\n\n## [0.1.0] - 2026-01-01\n");
		assert.throws(() => addUnreleasedSection(path), /does not start with a "# Changelog" heading/);
	});
});
