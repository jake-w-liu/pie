import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseNpmPackResult } from "./release-packages.mjs";

const publicPackages = [
	["telemetry", "pi-telemetry"],
	["ai", "pi-ai"],
	["tui", "pi-tui"],
	["agent", "pi-agent-core"],
	["protocol", "pi-protocol"],
	["client", "pi-client"],
	["session-backends/sqlite-node", "pi-session-backend-sqlite-node"],
	["server", "pi-server"],
	["coding-agent", "pi-coding-agent"],
	["pi-fff", "pi-ext-fff"],
	["pi-web-access", "pi-ext-web-access"],
	["pi-subagents", "pi-ext-subagents"],
];
const posixOnly = { skip: process.platform === "win32" ? "Fixture executables use POSIX shebangs" : false };

async function fixture(t, extraEnv = {}) {
	const root = await mkdtemp(join(tmpdir(), "pie-release-safety-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "project", "repo");
	const bin = join(root, "bin");
	const log = join(root, "commands.jsonl");
	await mkdir(join(repo, "scripts"), { recursive: true });
	await mkdir(bin);
	for (const script of ["local-release.mjs", "publish.mjs", "release-packages.mjs", "package-workspaces.mjs"]) {
		await copyFile(new URL(script, import.meta.url), join(repo, "scripts", script));
	}
	await writeFile(join(repo, "package.json"), JSON.stringify({ name: "pi-monorepo", private: true, type: "module" }));
	await writeFile(join(repo, "sentinel"), "owned source must survive");
	for (const [directory, shortName] of publicPackages) {
		const sourceOnly = shortName.startsWith("pi-ext-");
		const packageDirectory = join(repo, "packages", directory);
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({
				name: `@earendil-works/${shortName}`,
				version: "0.1.0",
				files: sourceOnly ? ["index.ts"] : ["dist"],
				main: sourceOnly ? "./index.ts" : "./dist/index.js",
			}),
		);
		if (sourceOnly) await writeFile(join(packageDirectory, "index.ts"), "export {};\n");
		else {
			await mkdir(join(packageDirectory, "dist"));
			await writeFile(join(packageDirectory, "dist", "index.js"), "export {};\n");
		}
	}
	await mkdir(join(repo, "packages", "private-example"));
	await writeFile(join(repo, "packages", "private-example", "package.json"), JSON.stringify({ name: "private-example", private: true }));
	await writeFile(log, "");
	await writeFile(
		join(bin, "npm"),
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify({cwd:process.cwd(), args}) + "\\n");
if (args[0] === "view") console.log(JSON.stringify("0.1.0"));
else if (args[0] === "pack") {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const filename = manifest.name.replaceAll("/", "-").replaceAll("@", "") + ".tgz";
  const packed = {name:manifest.name, filename, files:[{path:"package.json"}, {path:manifest.main.slice(2)}], size:1, unpackedSize:1};
  const destination = args.indexOf("--pack-destination");
  if (destination >= 0) fs.writeFileSync(path.join(args[destination + 1], filename), "owned fixture tarball");
  if (process.env.RELEASE_TEST_PACK_SHAPE === "invalid") console.log("null");
  else console.log(JSON.stringify(process.env.RELEASE_TEST_PACK_SHAPE === "array" ? [packed] : {[manifest.name]:packed}));
} else if (args[0] === "install") {
  const directory = path.join(process.cwd(), "node_modules", ".bin");
  fs.mkdirSync(directory, {recursive:true});
  fs.writeFileSync(path.join(directory, "pie"), "#!/bin/sh\\nprintf 'owned CLI fixture\\\\n'\\n", {mode:0o755});
} else if (args[0] !== "run") {
  console.error("Forbidden fixture command: " + args.join(" "));
  process.exit(93);
}
`,
	);
	await chmod(join(bin, "npm"), 0o755);
	await writeFile(join(bin, "bun"), "#!/bin/sh\nprintf 'fixture bun\\n'\n", { mode: 0o755 });
	await writeFile(
		join(repo, "scripts", "build-binaries.sh"),
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args[args.indexOf("--out") + 1];
const platform = args[args.indexOf("--platform") + 1];
fs.mkdirSync(path.join(output, platform), {recursive:true});
fs.writeFileSync(path.join(output, platform, "pi"), "owned binary fixture");
fs.writeFileSync(path.join(output, "pi-" + platform + ".tar.gz"), "owned archive fixture");
`,
		{ mode: 0o755 },
	);
	// Keep the executable fixture CommonJS even under the fake repository's ESM package.
	await writeFile(join(repo, "scripts", "package.json"), JSON.stringify({ type: "commonjs" }));
	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		HOME: root,
		RELEASE_TEST_LOG: log,
		...extraEnv,
	};
	return {
		root,
		repo,
		env,
		run(script, args = []) {
			return spawnSync(process.execPath, [join(repo, "scripts", script), ...args], {
				cwd: repo,
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
		},
		async commands() {
			return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		},
	};
}

const packOnlyArgs = ["--skip-check", "--skip-test", "--skip-install"];

for (const kind of ["repository", "ancestor", "dot-prefix child", "symlink child", "missing symlink child"]) {
	test(`local release rejects ${kind} output without deleting source`, posixOnly, async (t) => {
		const f = await fixture(t);
		let output = f.repo;
		if (kind === "ancestor") output = join(f.root, "project");
		if (kind === "dot-prefix child") output = join(f.repo, "..release");
		if (kind.includes("symlink")) {
			await symlink(f.repo, join(f.root, "alias"), "dir");
			output = join(f.root, "alias", "output");
		}
		if (kind !== "missing symlink child") {
			await mkdir(output, { recursive: true });
			await writeFile(join(output, "protected"), "do not delete");
		}
		const result = f.run("local-release.mjs", [...packOnlyArgs, "--force", "--out", output]);
		assert.notEqual(result.status, 0, result.stdout);
		assert.equal(await readFile(join(f.repo, "sentinel"), "utf8"), "owned source must survive");
		if (kind !== "missing symlink child") assert.equal(await readFile(join(output, "protected"), "utf8"), "do not delete");
		assert.match(result.stderr, /Output directory must be outside the repository/);
		assert.deepEqual(await f.commands(), []);
	});
}

test("local release also rejects generated output inside the repository", posixOnly, async (t) => {
	const f = await fixture(t);
	f.env.TMPDIR = f.repo;
	const result = f.run("local-release.mjs", packOnlyArgs);
	assert.notEqual(result.status, 0, result.stdout);
	assert.match(result.stderr, /Output directory must be outside the repository/);
	assert.deepEqual(await f.commands(), []);
});

test("local release packs all public workspaces without lifecycle scripts and accepts sibling output", posixOnly, async (t) => {
	const f = await fixture(t);
	const output = join(f.root, "project", "repo-sibling");
	const result = f.run("local-release.mjs", [...packOnlyArgs, "--out", output]);
	assert.equal(result.status, 0, result.stderr);
	const commands = await f.commands();
	const packed = commands.filter(({ args }) => args[0] === "pack");
	const packageDirectories = await Promise.all(publicPackages.map(([directory]) => realpath(join(f.repo, "packages", directory))));
	assert.deepEqual(packed.map(({ cwd }) => cwd).sort(), packageDirectories.sort());
	for (const { args } of packed) assert.ok(args.includes("--ignore-scripts"));
});

test("local release creates a working pi shim for the installed pie command", posixOnly, async (t) => {
	const f = await fixture(t);
	const output = join(f.root, "release");
	const result = f.run("local-release.mjs", ["--skip-check", "--skip-test", "--skip-bun-install", "--out", output]);
	assert.equal(result.status, 0, result.stderr);
	const cli = spawnSync(join(output, "node", "pi"), ["--help"], { cwd: f.root, env: f.env, encoding: "utf8" });
	assert.equal(cli.status, 0, String(cli.error ?? cli.stderr));
	assert.equal(cli.stdout, "owned CLI fixture\n");
	const manifest = JSON.parse(await readFile(join(output, "node", "package.json"), "utf8"));
	for (const [, shortName] of publicPackages) assert.match(manifest.dependencies[`@earendil-works/${shortName}`], /^file:/);
	assert.deepEqual(manifest.overrides, manifest.dependencies);
});

for (const shape of ["object", "array"]) {
	test(`publish dry run accepts npm ${shape} pack results and source-only packages`, posixOnly, async (t) => {
		const f = await fixture(t, { RELEASE_TEST_PACK_SHAPE: shape });
		const result = f.run("publish.mjs", ["--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		const commands = await f.commands();
		assert.equal(commands.filter(({ args }) => args[0] === "pack").length, publicPackages.length);
		assert.ok(commands.every(({ args }) => args[0] !== "publish"));
	});
}

test("publish still rejects missing compiled build output", posixOnly, async (t) => {
	const f = await fixture(t, { RELEASE_TEST_PACK_SHAPE: "array" });
	await rm(join(f.repo, "packages", "ai", "dist"), { recursive: true });
	const result = f.run("publish.mjs", ["--dry-run"]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /packages\/ai\/dist does not exist/);
});

test("release commands reject malformed pack output with a package diagnostic", posixOnly, async (t) => {
	for (const script of ["publish.mjs", "local-release.mjs"]) {
		const f = await fixture(t, { RELEASE_TEST_PACK_SHAPE: "invalid" });
		const args = script === "publish.mjs" ? ["--dry-run"] : [...packOnlyArgs, "--out", join(f.root, "release")];
		const result = f.run(script, args);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Invalid npm pack result for @earendil-works\//);
	}
});

test("pack validation checks effective exports, wildcard subpaths and CLI entrypoints", () => {
	const manifest = {
		name: "source-extension",
		main: "./dist/unused.js",
		types: "./dist/unused.d.ts",
		exports: {
			".": { types: "./index.ts", import: "./index.ts" },
			"./api/*": "./src/*.ts",
			"./disabled": null,
		},
		bin: { pie: "bin/cli.js" },
		pi: { extensions: ["./index.ts"] },
	};
	const packed = {
		name: manifest.name,
		filename: "source-extension.tgz",
		files: ["package.json", "index.ts", "src/nested/provider.ts", "bin/cli.js"].map((path) => ({ path })),
		size: 1,
		unpackedSize: 1,
	};
	for (const output of [[packed], { [manifest.name]: packed }]) {
		assert.deepEqual(parseNpmPackResult(JSON.stringify(output), manifest), packed);
	}
	for (const missing of packed.files) {
		const incomplete = { ...packed, files: packed.files.filter((file) => file !== missing) };
		assert.throws(() => parseNpmPackResult(JSON.stringify([incomplete]), manifest), /omit declared entrypoint/);
	}
	const sourceManifest = { name: manifest.name, main: "./index.ts", types: "./types.d.ts" };
	assert.throws(() => parseNpmPackResult(JSON.stringify([packed]), sourceManifest), /omit declared entrypoint types\.d\.ts/);
});

test("pack validation rejects ambiguous, malformed, mismatched and unsafe artifact metadata", () => {
	const manifest = { name: "test-package" };
	const packed = { name: manifest.name, filename: "test-package.tgz", files: [{ path: "package.json" }], size: 1, unpackedSize: 1 };
	const malformed = [
		null, 0, "text", [], {}, [packed, packed],
		[{ ...packed, name: "other-package" }],
		[{ ...packed, filename: "../outside.tgz" }],
		[{ ...packed, filename: "" }],
		[{ ...packed, files: [null] }],
		[{ ...packed, files: [{ path: 1 }] }],
	];
	for (const output of malformed) {
		assert.throws(() => parseNpmPackResult(JSON.stringify(output), manifest), /Invalid npm pack result for test-package/);
	}
	assert.throws(() => parseNpmPackResult("{", manifest), /Invalid npm pack result for test-package/);
});
