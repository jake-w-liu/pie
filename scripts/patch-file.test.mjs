import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert";

function runPatch(spec) {
	const dir = mkdtempSync(join(tmpdir(), "patch-test-"));
	const specPath = join(dir, "spec.json");
	writeFileSync(specPath, JSON.stringify(spec));
	const res = spawnSync(process.execPath, [new URL("./patch-file.mjs", import.meta.url).pathname, specPath], {
		encoding: "utf8",
	});
	rmSync(dir, { recursive: true, force: true });
	return res;
}

test("patch-file: exact unique replace", () => {
	const file = join(tmpdir(), `patch-${Date.now()}.txt`);
	writeFileSync(file, "a\nb\nc\n");
	const res = runPatch({ file, old: "b", new: "B" });
	assert.strictEqual(res.status, 0, res.stderr);
	assert.strictEqual(readFileSync(file, "utf8"), "a\nB\nc\n");
	rmSync(file, { force: true });
});

test("patch-file: whitespace-tolerant replace (tab vs spaces)", () => {
	const file = join(tmpdir(), `patch-${Date.now()}.txt`);
	writeFileSync(file, "function f() {\n\tconst x = 1;\n}\n");
	const res = runPatch({ file, old: "    const x = 1;", new: "    const x = 9;" });
	assert.strictEqual(res.status, 0, res.stderr);
	assert.ok(readFileSync(file, "utf8").includes("const x = 9;"), readFileSync(file, "utf8"));
	rmSync(file, { force: true });
});

test("patch-file: refuses ambiguous matches", () => {
	const file = join(tmpdir(), `patch-${Date.now()}.txt`);
	writeFileSync(file, "a\nb\na\n");
	const res = runPatch({ file, old: "a", new: "X" });
	assert.strictEqual(res.status, 1);
	assert.match(res.stderr, /AMBIGUOUS/);
	rmSync(file, { force: true });
});

test("patch-file: all replaces every occurrence", () => {
	const file = join(tmpdir(), `patch-${Date.now()}.txt`);
	writeFileSync(file, "pi-fff\nx\npi-fff\n");
	const res = runPatch({ file, old: "pi-fff", new: "pi-ext-fff", all: true });
	assert.strictEqual(res.status, 0, res.stderr);
	assert.strictEqual(readFileSync(file, "utf8"), "pi-ext-fff\nx\npi-ext-fff\n");
	rmSync(file, { force: true });
});

test("patch-file: reports not found", () => {
	const file = join(tmpdir(), `patch-${Date.now()}.txt`);
	writeFileSync(file, "abc\n");
	const res = runPatch({ file, old: "zzz", new: "yyy" });
	assert.strictEqual(res.status, 1);
	assert.match(res.stderr, /NOT FOUND/);
	rmSync(file, { force: true });
});
