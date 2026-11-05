import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nextPatchVersion, updateReadmeVersion } from "./bump-version.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const refreshScript = readFileSync(join(repositoryRoot, "scripts/refresh-pie.sh"), "utf8");
const isolatedGitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.test",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.test",
};

const temporaryRoots = [];
test.afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function extractFunction(name) {
	const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(refreshScript);
	assert.ok(match, `${name}() not found in refresh-pie.sh`);
	return match[0];
}

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedGitEnv });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

const FAKE_BUMP = `import { readFileSync, writeFileSync } from "node:fs";
const path = "packages/coding-agent/package.json";
const pkg = JSON.parse(readFileSync(path, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
pkg.version = \`\${major}.\${minor}.\${patch + 1}\`;
writeFileSync(path, JSON.stringify(pkg, null, "\\t") + "\\n");
if (process.env.FAKE_BUMP_FAIL === "1") process.exit(1);
writeFileSync("package-lock.json", JSON.stringify({ version: pkg.version }) + "\\n");
writeFileSync("README.md", readFileSync("README.md", "utf8").replace(/\`\\d+\\.\\d+\\.\\d+\`/, \`\\\`\${pkg.version}\\\`\`));
console.log(pkg.version);
`;

/** A checkout on main with an upstream in a bare remote, plus the files a refresh bump touches. */
function createCheckout() {
	const root = mkdtempSync(join(tmpdir(), "pie-refresh-bump-"));
	temporaryRoots.push(root);
	const remote = join(root, "remote.git");
	const work = join(root, "work");
	git(root, "init", "--bare", "-q", "-b", "main", remote);
	git(root, "init", "-q", "-b", "main", work);
	mkdirSync(join(work, "packages/coding-agent"), { recursive: true });
	mkdirSync(join(work, "scripts"));
	writeFileSync(
		join(work, "packages/coding-agent/package.json"),
		`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.1.0" }, null, "\t")}\n`,
	);
	writeFileSync(join(work, "package-lock.json"), `${JSON.stringify({ version: "0.1.0" })}\n`);
	writeFileSync(join(work, "README.md"), "- **Pie version:** `0.1.0`\n");
	writeFileSync(join(work, "notes.txt"), "base\n");
	writeFileSync(join(work, "scripts/bump-version.mjs"), FAKE_BUMP);
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "base");
	git(work, "remote", "add", "origin", remote);
	git(work, "push", "-q", "-u", "origin", "main");
	return { root, remote, work };
}

function runBump(work, { push = true, env = {} } = {}) {
	const probe = `set -euo pipefail
${extractFunction("read_package_field")}
${extractFunction("bump_commit_and_push")}
${extractFunction("restore_version_files")}
repo_dir="$PWD"
push=${push}
bump_backup_dir=""
bump_applied=false
bump_committed=false
push_failed=false
previous_version=""
new_version=""
bump_commit=""
trap 'if [[ "$bump_applied" == true && "$bump_committed" != true ]]; then restore_version_files; fi' EXIT
bump_commit_and_push
printf 'RESULT %s %s %s\\n' "$new_version" "$bump_committed" "$push_failed"
`;
	return spawnSync("bash", ["-c", probe], { cwd: work, encoding: "utf8", env: { ...isolatedGitEnv, ...env } });
}

test("bump helper computes the next patch version and updates the README version line", () => {
	assert.equal(nextPatchVersion("0.1.9"), "0.1.10");
	assert.throws(() => nextPatchVersion("1.2"), /major\.minor\.patch/);
	assert.equal(updateReadmeVersion("- **Pie version:** `0.1.0`\nrest", "0.1.1"), "- **Pie version:** `0.1.1`\nrest");
	assert.equal(updateReadmeVersion("no version line", "0.1.1"), "no version line");
});

test("refresh commits only the version bump and pushes it", { skip: process.platform === "win32" }, () => {
	const { remote, work } = createCheckout();
	writeFileSync(join(work, "notes.txt"), "uncommitted work\n");
	writeFileSync(join(work, "staged.txt"), "staged work\n");
	git(work, "add", "staged.txt");

	const result = runBump(work);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /RESULT 0\.1\.1 true false/);
	assert.equal(git(work, "log", "-1", "--format=%s"), "Bump version to 0.1.1");
	assert.deepEqual(git(work, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [
		"README.md",
		"package-lock.json",
		"packages/coding-agent/package.json",
	]);
	assert.equal(git(remote, "rev-parse", "main"), git(work, "rev-parse", "HEAD"));
	// Unrelated staged and unstaged work stays out of the version commit.
	assert.equal(git(work, "status", "--porcelain", "--", "notes.txt", "staged.txt"), "M notes.txt\nA  staged.txt");
});

test("refresh refuses to bump over uncommitted version-file edits", { skip: process.platform === "win32" }, () => {
	const { work } = createCheckout();
	writeFileSync(join(work, "README.md"), "- **Pie version:** `0.1.0`\nlocal edit\n");

	const result = runBump(work);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /version files have uncommitted changes/);
	assert.equal(git(work, "log", "-1", "--format=%s"), "base");
	assert.match(readFileSync(join(work, "packages/coding-agent/package.json"), "utf8"), /"0\.1\.0"/);
});

test("refresh refuses to bump a branch that is behind its upstream", { skip: process.platform === "win32" }, () => {
	const { root, remote, work } = createCheckout();
	const other = join(root, "other");
	git(root, "clone", "-q", remote, other);
	writeFileSync(join(other, "notes.txt"), "remote change\n");
	git(other, "commit", "-q", "-am", "remote change");
	git(other, "push", "-q", "origin", "main");

	const result = runBump(work);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /behind origin refs\/heads\/main/);
	assert.match(readFileSync(join(work, "packages/coding-agent/package.json"), "utf8"), /"0\.1\.0"/);
});

test("refresh restores version files when the bump fails", { skip: process.platform === "win32" }, () => {
	const { work } = createCheckout();
	const before = readFileSync(join(work, "packages/coding-agent/package.json"), "utf8");

	const result = runBump(work, { env: { FAKE_BUMP_FAIL: "1" } });

	assert.notEqual(result.status, 0);
	assert.equal(readFileSync(join(work, "packages/coding-agent/package.json"), "utf8"), before);
	assert.equal(git(work, "status", "--porcelain"), "");
	assert.equal(git(work, "log", "-1", "--format=%s"), "base");
});

test("refresh keeps the local version commit and reports a failed push", { skip: process.platform === "win32" }, () => {
	const { remote, work } = createCheckout();
	writeFileSync(join(remote, "hooks/pre-receive"), "#!/bin/sh\necho rejected >&2\nexit 1\n", { mode: 0o755 });

	const result = runBump(work);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /RESULT 0\.1\.1 true true/);
	assert.match(result.stderr, /git push failed/);
	assert.equal(git(work, "log", "-1", "--format=%s"), "Bump version to 0.1.1");
	assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "base");
});

test("refresh with --no-push commits without contacting the remote", { skip: process.platform === "win32" }, () => {
	const { remote, work } = createCheckout();
	git(work, "remote", "set-url", "origin", join(remote, "missing.git"));

	const result = runBump(work, { push: false });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /RESULT 0\.1\.1 true false/);
	assert.equal(git(work, "log", "-1", "--format=%s"), "Bump version to 0.1.1");
});

/** A release root with managed releases (each with the refresh marker unless marker is false). */
function createReleaseRoot() {
	const root = mkdtempSync(join(tmpdir(), "pie-refresh-prune-"));
	temporaryRoots.push(root);
	const releases = join(root, "pie-releases");
	const release = (name, { marker = true } = {}) => {
		const directory = join(releases, name);
		mkdirSync(join(directory, "node_modules"), { recursive: true });
		if (marker) writeFileSync(join(directory, ".pie-refresh-release"), "");
		return directory;
	};
	return { root, releases, release };
}

function runPrune(releases, active, env) {
	const probe = `set -euo pipefail
releases_dir="$1"
${extractFunction("remove_owned_directory")}
${extractFunction("remove_managed_release")}
${extractFunction("release_in_use")}
${extractFunction("retain_in_use_release")}
${extractFunction("prune_old_releases")}
prune_old_releases "$2"
release_in_use "$2" && echo "active in use" || echo "active free"
`;
	// An absolute bash path, because env.PATH may deliberately lack common tools.
	return spawnSync("/bin/bash", ["-c", probe, "probe", releases, active], { encoding: "utf8", env });
}

test("refresh removes every old release that no running process uses", { skip: process.platform === "win32" }, () => {
	const { root, releases, release } = createReleaseRoot();
	const active = release("release.ACTIVE");
	const old = [release("release.OLD001"), release("release.OLD002")];
	const live = release("release.LIVE01");
	const unmarked = release("release.NOMARK", { marker: false });
	const linkTarget = join(root, "link-target");
	mkdirSync(linkTarget);
	writeFileSync(join(linkTarget, ".pie-refresh-release"), "");
	symlinkSync(linkTarget, join(releases, "release.LINK01"));
	// A running Pie process keeps its installation's package.json open (pinInstallation).
	const bin = join(root, "bin");
	mkdirSync(bin);
	const lsofLog = join(root, "lsof.log");
	writeFileSync(
		join(bin, "lsof"),
		`#!/bin/bash\nprintf '%s\\n' "$*" >> "${lsofLog}"\necho p123\necho "n${live}/node_modules/@earendil-works/pi-coding-agent/package.json"\n`,
		{ mode: 0o755 },
	);

	const result = runPrune(releases, active, { ...process.env, PATH: `${bin}:${process.env.PATH}` });

	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(active));
	assert.match(result.stdout, /active free/);
	for (const directory of old) assert.ok(!existsSync(directory), `${directory} was not removed`);
	assert.ok(existsSync(live));
	assert.match(result.stderr, /keeping release .*release\.LIVE01, which a running Pie process uses/);
	assert.ok(existsSync(unmarked));
	assert.match(result.stderr, /without a release marker: .*release\.NOMARK/);
	// A symlink is neither followed nor removed.
	assert.ok(existsSync(join(releases, "release.LINK01")));
	assert.ok(existsSync(join(linkTarget, ".pie-refresh-release")));
	// Name lookups made a single system-wide listing take about 26 seconds on macOS.
	for (const line of readFileSync(lsofLog, "utf8").trim().split("\n")) assert.equal(line, "-n -P -F n");
});

test("refresh keeps old releases when it cannot check whether they are in use", { skip: process.platform === "win32" }, () => {
	const { root, releases, release } = createReleaseRoot();
	const active = release("release.ACTIVE");
	const old = release("release.OLD001");
	const emptyBin = join(root, "empty-bin");
	mkdirSync(emptyBin);

	const result = runPrune(releases, active, { ...process.env, PATH: emptyBin });

	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(old));
	assert.match(result.stderr, /lsof not found; keeping old releases/);
	// Without lsof, release_in_use reports every release as in use.
	assert.match(result.stdout, /active in use/);
});
