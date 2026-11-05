import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const isolatedGitEnv = {
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

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...isolatedGitEnv } });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

const REFRESH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$REFRESH_LOG"
echo "Installed Pie 9.9.9 from $(git rev-parse --short=12 HEAD)"
`;
const NPM_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_LOG"
`;

/** A Pie-like checkout on main tracking a bare remote, with stubbed refresh and npm. */
function createCheckout() {
	const root = mkdtempSync(join(tmpdir(), "pie-update-"));
	temporaryRoots.push(root);
	const remote = join(root, "remote.git");
	const work = join(root, "work");
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	writeFileSync(join(bin, "npm"), NPM_STUB, { mode: 0o755 });
	git(root, "init", "--bare", "-q", "-b", "main", remote);
	git(root, "init", "-q", "-b", "main", work);
	mkdirSync(join(work, "scripts"));
	mkdirSync(join(work, "node_modules"));
	writeFileSync(join(work, ".gitignore"), "node_modules/\n");
	writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "pi-monorepo" })}\n`);
	writeFileSync(join(work, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 })}\n`);
	// Installed dependencies are newer than the lockfile, as right after npm ci. Explicit times keep
	// the comparison independent of how fast this setup runs.
	setModified(join(work, "package-lock.json"), -3600);
	writeFileSync(join(work, "node_modules/.package-lock.json"), "{}\n");
	writeFileSync(join(work, "notes.txt"), "base\n");
	copyFileSync(join(repositoryRoot, "scripts/update-pie.sh"), join(work, "scripts/update-pie.sh"));
	writeFileSync(join(work, "scripts/refresh-pie.sh"), REFRESH_STUB, { mode: 0o755 });
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "base");
	git(work, "remote", "add", "origin", remote);
	git(work, "push", "-q", "-u", "origin", "main");
	const other = join(root, "other");
	git(root, "clone", "-q", remote, other);
	return { root, remote, work, other, home, bin };
}

/** Set a file's modification time to now plus offsetSeconds. */
function setModified(path, offsetSeconds) {
	const time = Date.now() / 1000 + offsetSeconds;
	utimesSync(path, time, time);
}

function pushRemoteChange(other, file, content) {
	writeFileSync(join(other, file), content);
	git(other, "add", file);
	git(other, "commit", "-q", "-m", `change ${file}`);
	git(other, "push", "-q", "origin", "main");
}

function runUpdate({ work, home, bin, root }, ...args) {
	const env = {
		...process.env,
		...isolatedGitEnv,
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		REFRESH_LOG: join(root, "refresh.log"),
		NPM_LOG: join(root, "npm.log"),
	};
	const result = spawnSync("bash", [join(work, "scripts/update-pie.sh"), ...args], { cwd: work, encoding: "utf8", env });
	const read = (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim() : "");
	return { ...result, refreshCalls: read("refresh.log"), npmCalls: read("npm.log") };
}

test("update fast-forwards to the upstream and reinstalls without bumping", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	pushRemoteChange(checkout.other, "notes.txt", "remote change\n");

	const result = runUpdate(checkout);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(checkout.work, "notes.txt"), "utf8"), "remote change\n");
	assert.equal(git(checkout.work, "rev-parse", "HEAD"), git(checkout.remote, "rev-parse", "main"));
	assert.equal(result.refreshCalls, "--no-bump");
	// The lockfile did not change and dependencies are installed, so npm is not run.
	assert.equal(result.npmCalls, "");
});

test("update reinstalls dependencies when the lockfile changes", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	pushRemoteChange(checkout.other, "package-lock.json", `${JSON.stringify({ lockfileVersion: 3, changed: true })}\n`);

	const result = runUpdate(checkout, "--check");

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.npmCalls, "ci --ignore-scripts --no-audit --no-fund");
	assert.equal(result.refreshCalls, "--no-bump --check");
});

test("update reinstalls dependencies that predate the lockfile", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	// The lockfile changed after the last install without this update fast-forwarding it, as after
	// a manual git pull or an update that was interrupted before npm ci.
	setModified(join(checkout.work, "node_modules/.package-lock.json"), -7200);

	const result = runUpdate(checkout);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.npmCalls, "ci --ignore-scripts --no-audit --no-fund");
	assert.equal(result.refreshCalls, "--no-bump");
});

test("update skips reinstalling when the installed build matches the upstream", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	mkdirSync(join(checkout.home, ".local/share/pie"), { recursive: true });
	writeFileSync(
		join(checkout.home, ".local/share/pie/source.json"),
		`${JSON.stringify({ repository: checkout.work, revision: git(checkout.work, "rev-parse", "HEAD"), dirty: false })}\n`,
	);

	const result = runUpdate(checkout);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Pie is already up to date/);
	assert.equal(result.refreshCalls, "");
});

test("update refuses uncommitted changes without fetching or reinstalling", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	pushRemoteChange(checkout.other, "notes.txt", "remote change\n");
	writeFileSync(join(checkout.work, "notes.txt"), "local edit\n");

	const result = runUpdate(checkout);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /uncommitted changes/);
	assert.equal(readFileSync(join(checkout.work, "notes.txt"), "utf8"), "local edit\n");
	assert.equal(result.refreshCalls, "");
});

test("update refuses a branch that diverged from its upstream", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	pushRemoteChange(checkout.other, "notes.txt", "remote change\n");
	writeFileSync(join(checkout.work, "local.txt"), "local commit\n");
	git(checkout.work, "add", "local.txt");
	git(checkout.work, "commit", "-q", "-m", "local commit");
	const before = git(checkout.work, "rev-parse", "HEAD");

	const result = runUpdate(checkout);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /diverged/);
	assert.equal(git(checkout.work, "rev-parse", "HEAD"), before);
	assert.equal(result.refreshCalls, "");
});

test("update installs a local branch that is ahead of its upstream", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	writeFileSync(join(checkout.work, "local.txt"), "local commit\n");
	git(checkout.work, "add", "local.txt");
	git(checkout.work, "commit", "-q", "-m", "local commit");

	const result = runUpdate(checkout);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /1 commit\(s\) that are not on origin/);
	assert.equal(result.refreshCalls, "--no-bump");
});

test("update rejects bump and push options", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	for (const option of ["--no-bump", "--no-push"]) {
		const result = runUpdate(checkout, option);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /updating never bumps or pushes/);
	}
	assert.equal(runUpdate(checkout).refreshCalls, "--no-bump");
});

test("refresh records the source checkout of each release", { skip: process.platform === "win32" }, () => {
	const checkout = createCheckout();
	const script = readFileSync(join(repositoryRoot, "scripts/refresh-pie.sh"), "utf8");
	const writer = /^write_source_metadata\(\) \{\n[\s\S]*?\n\}$/m.exec(script)?.[0];
	assert.ok(writer, "write_source_metadata() not found in refresh-pie.sh");
	const destination = join(checkout.root, "source.json");
	const head = git(checkout.work, "rev-parse", "HEAD");
	const write = (dirty) => {
		const probe = `set -euo pipefail\nrepo_dir="$1"\n${writer}\nwrite_source_metadata "$2" 9.9.9 "$3" "$4"\n`;
		const result = spawnSync("bash", ["-c", probe, "probe", checkout.work, destination, head, dirty], {
			encoding: "utf8",
			env: { ...process.env, ...isolatedGitEnv },
		});
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(readFileSync(destination, "utf8"));
	};

	assert.deepEqual(write("false"), {
		repository: checkout.work,
		branch: "main",
		remote: "origin",
		remoteUrl: checkout.remote,
		revision: head,
		dirty: false,
		version: "9.9.9",
	});
	// The dirty state comes from the start of the build, not from the tree when the build ends.
	assert.equal(write("true").dirty, true);
});
