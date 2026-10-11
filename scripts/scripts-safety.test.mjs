import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoots = [];
test.afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", ...options });
}

function git(root, ...args) {
	const result = run("git", args, { cwd: root });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function initializeGit(root) {
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.test");
	git(root, "config", "user.name", "Test");
}

function evaluateGithubCondition(condition, context) {
	const source = condition.replace(/^\s*\$\{\{\s*/, "").replace(/\s*\}\}\s*$/, "");
	const translated = source.replace(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g, (reference) => {
		let value = context;
		for (const part of reference.split(".")) value = value?.[part];
		return JSON.stringify(value ?? null);
	});
	const syntaxOnly = translated
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/\b(?:true|false|null)\b/g, "");
	assert.match(syntaxOnly, /^[\s()=!&|"']+$/, `Unsupported workflow expression: ${condition}`);
	return Function(`"use strict"; return Boolean(${translated});`)();
}

test("model catalog workflow rejects fork workflow_run commits", () => {
	const workflow = parseYaml(readFileSync(join(repositoryRoot, ".github/workflows/publish-model-catalog.yml"), "utf8"));
	const generate = workflow.jobs.generate;
	assert.equal(generate.env.SOURCE_REF, "${{ github.event.workflow_run.head_sha || inputs.source_ref || github.sha }}");

	const workflowRun = (overrides = {}) => ({
		github: {
			event_name: "workflow_run",
			repository: "earendil-works/pie",
			event: {
				workflow_run: {
					conclusion: "success",
					head_branch: "main",
					head_repository: { full_name: "earendil-works/pie" },
					...overrides,
				},
			},
		},
	});
	assert.equal(evaluateGithubCondition(generate.if, workflowRun()), true);
	assert.equal(
		evaluateGithubCondition(generate.if, workflowRun({ head_repository: { full_name: "attacker/fork" } })),
		false,
	);
	assert.equal(evaluateGithubCondition(generate.if, workflowRun({ head_branch: "feature" })), false);
	assert.equal(evaluateGithubCondition(generate.if, workflowRun({ conclusion: "failure" })), false);
	assert.equal(evaluateGithubCondition(generate.if, { github: { event_name: "workflow_dispatch" } }), true);
});

test("binary build refuses to erase an unowned output directory", () => {
	const root = temporaryRoot("pi-binaries-safety-");
	const output = join(root, "victim");
	mkdirSync(output);
	writeFileSync(join(output, "sentinel"), "keep");
	const result = run("bash", [
		join(repositoryRoot, "scripts/build-binaries.sh"),
		"--skip-install", "--skip-deps", "--skip-build", "--platform", "darwin-arm64", "--out", output,
	], { cwd: repositoryRoot });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing to replace unowned output path/);
	assert.equal(readFileSync(join(output, "sentinel"), "utf8"), "keep");
});

test("binary build refuses to erase an existing file at the output path", () => {
	const root = temporaryRoot("pi-binaries-safety-file-");
	const output = join(root, "victim.txt");
	writeFileSync(output, "keep");
	const result = run("bash", [
		join(repositoryRoot, "scripts/build-binaries.sh"),
		"--skip-install", "--skip-deps", "--skip-build", "--platform", "darwin-arm64", "--out", output,
	], { cwd: repositoryRoot });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing to replace unowned output path/);
	assert.equal(readFileSync(output, "utf8"), "keep");
});

test("catalog publication validates all required model fields and optional pricing structures", () => {
	const root = temporaryRoot("pi-invalid-catalog-");
	const providers = ["anthropic", "openai", "openrouter"];
	const validModels = Object.fromEntries(providers.map((provider) => [provider, {}]));
	for (let index = 0; index < 500; index++) {
		const provider = providers[index % providers.length];
		const id = `model-${index}`;
		validModels[provider][id] = {
			id,
			provider,
			name: id,
			api: "openai-completions",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
	}
	validModels.anthropic["model-0"].cost = {
		input: 1,
		output: 2,
		cacheRead: 0.5,
		cacheWrite: 0,
		tiers: [{ input: 0.8, output: 1.8, cacheRead: 0.4, cacheWrite: 0, inputTokensAbove: 1000 }],
		peak: {
			rates: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 },
			windows: [{ days: [1, 2, 3, 4, 5], startMinutes: 60, endMinutes: 240 }],
		},
	};
	mkdirSync(join(root, "providers"));
	writeFileSync(join(root, "providers.json"), JSON.stringify(providers));

	const validate = (models) => {
		writeFileSync(join(root, "models.json"), JSON.stringify(models));
		for (const provider of providers) {
			writeFileSync(join(root, "providers", `${provider}.json`), JSON.stringify(models[provider]));
		}
		return run(process.execPath, [
			join(repositoryRoot, "scripts/publish-model-catalog.mjs"),
			"--input",
			root,
			"--dry-run",
		]);
	};

	let result = validate(validModels);
	assert.equal(result.status, 0, result.stderr);

	// Deployment-scoped providers (azure-openai-responses) publish an empty baseUrl and resolve it at call time.
	const deploymentScoped = structuredClone(validModels);
	for (const models of Object.values(deploymentScoped)) {
		for (const model of Object.values(models)) model.baseUrl = "";
	}
	result = validate(deploymentScoped);
	assert.equal(result.status, 0, result.stderr);

	const invalidCases = [
		["model object", (models) => { models.anthropic["model-0"] = null; }, /Invalid model entry/],
		["id", (model) => { delete model.id; }, /Invalid model entry/],
		["provider", (model) => { delete model.provider; }, /Invalid model entry/],
		["api", (model) => { delete model.api; }, /api must be a non-empty string/],
		["name", (model) => { delete model.name; }, /name must be a non-empty string/],
		["baseUrl", (model) => { delete model.baseUrl; }, /baseUrl must be a string/],
		["reasoning", (model) => { delete model.reasoning; }, /reasoning must be a boolean/],
		["input", (model) => { delete model.input; }, /input must contain supported modalities/],
		["contextWindow", (model) => { delete model.contextWindow; }, /contextWindow must be a positive finite number/],
		["maxTokens", (model) => { delete model.maxTokens; }, /maxTokens must be a positive finite number/],
		["cost", (model) => { delete model.cost; }, /cost must be an object/],
		...["input", "output", "cacheRead", "cacheWrite"].map((field) => [
			`cost.${field}`,
			(model) => { delete model.cost[field]; },
			new RegExp(`cost\\.${field} must be a non-negative finite number`),
		]),
		["cost.tiers", (model) => { model.cost.tiers = {}; }, /cost\.tiers must be an array/],
		["cost tier rates", (model) => { model.cost.tiers[0].input = -1; }, /cost\.tiers\[0\]\.input/],
		["cost tier threshold", (model) => { model.cost.tiers[0].inputTokensAbove = -1; }, /cost tier thresholds/],
		["cost.peak", (model) => { model.cost.peak = true; }, /cost\.peak must be an object/],
		...["input", "output", "cacheRead", "cacheWrite"].map((field) => [
			`cost.peak.rates.${field}`,
			(model) => { model.cost.peak.rates[field] = -1; },
			new RegExp(`cost\\.peak\\.rates\\.${field}`),
		]),
		["cost.peak.windows", (model) => { model.cost.peak.windows = {}; }, /cost\.peak\.windows must be an array/],
		["peak window object", (model) => { model.cost.peak.windows[0] = null; }, /windows\[0\] must be an object/],
		["peak start minutes", (model) => { model.cost.peak.windows[0].startMinutes = -1; }, /startMinutes/],
		["peak end minutes", (model) => { model.cost.peak.windows[0].endMinutes = 1440; }, /endMinutes/],
		["peak weekdays array", (model) => { model.cost.peak.windows[0].days = "Monday"; }, /days must contain/],
		["peak weekdays values", (model) => { model.cost.peak.windows[0].days = [7]; }, /days must contain/],
	];

	for (const [name, mutate, expectedError] of invalidCases) {
		const models = structuredClone(validModels);
		if (name === "model object") mutate(models);
		else mutate(models.anthropic["model-0"]);
		result = validate(models);
		assert.notEqual(result.status, 0, `${name} unexpectedly passed validation`);
		assert.match(result.stderr, expectedError, name);
	}
});

test("lockfile guard allows only resolved workspace package roots", () => {
	const root = temporaryRoot("pi-lock-guard-");
	initializeGit(root);
	mkdirSync(join(root, "packages", "real"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
	writeFileSync(join(root, "packages", "real", "package.json"), JSON.stringify({ name: "real", version: "1.0.0" }));
	const lockPath = join(root, "package-lock.json");
	const baseLock = {
		lockfileVersion: 3,
		packages: {
			"": { workspaces: ["packages/*"] },
			"packages/real": { name: "real", version: "1.0.0" },
		},
	};
	writeFileSync(lockPath, JSON.stringify(baseLock));
	git(root, "add", ".");
	git(root, "commit", "-qm", "initial");

	const rootOnly = structuredClone(baseLock);
	rootOnly.packages["packages/real"].version = "1.1.0";
	writeFileSync(lockPath, JSON.stringify(rootOnly));
	git(root, "add", "package-lock.json");
	let result = run(process.execPath, [join(repositoryRoot, "scripts/check-lockfile-commit.mjs")], { cwd: root });
	assert.equal(result.status, 0, result.stderr);

	git(root, "reset", "--hard", "-q");
	const ghostWorkspace = structuredClone(baseLock);
	ghostWorkspace.packages["packages/ghost"] = { name: "ghost", version: "1.0.0" };
	writeFileSync(lockPath, JSON.stringify(ghostWorkspace));
	mkdirSync(join(root, "packages", "ghost"));
	writeFileSync(join(root, "packages", "ghost", "package.json"), JSON.stringify({ name: "ghost", version: "1.0.0" }));
	git(root, "add", "package-lock.json");
	result = run(process.execPath, [join(repositoryRoot, "scripts/check-lockfile-commit.mjs")], { cwd: root });
	assert.equal(result.status, 1, "an unstaged workspace package must not qualify for the exemption");
	assert.match(result.stderr, /Review lockfile changes before committing/);

	git(root, "add", "packages/ghost/package.json");
	result = run(process.execPath, [join(repositoryRoot, "scripts/check-lockfile-commit.mjs")], { cwd: root });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /only updates workspace package metadata/);

	git(root, "reset", "--hard", "-q");
	const fakeWorkspace = structuredClone(baseLock);
	fakeWorkspace.packages["packages/not-a-workspace"] = {
		name: "external",
		version: "9.9.9",
		resolved: "https://registry.npmjs.org/external/-/external-9.9.9.tgz",
		integrity: "sha512-malicious",
	};
	writeFileSync(lockPath, JSON.stringify(fakeWorkspace));
	git(root, "add", "package-lock.json");
	result = run(process.execPath, [join(repositoryRoot, "scripts/check-lockfile-commit.mjs")], { cwd: root });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Review lockfile changes before committing/);
});

test("pre-commit hook refuses partially staged files without staging the remaining edits", () => {
	const root = temporaryRoot("pi-hook-safety-");
	initializeGit(root);
	mkdirSync(join(root, "scripts"));
	writeFileSync(join(root, "scripts/check-lockfile-commit.mjs"), "process.exit(0);\n");
	writeFileSync(join(root, "example.ts"), "base\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "initial");
	writeFileSync(join(root, "example.ts"), "base\nstaged\n");
	git(root, "add", "example.ts");
	writeFileSync(join(root, "example.ts"), "base\nstaged\nUNSTAGED-SECRET\n");
	const result = run("sh", [join(repositoryRoot, ".husky/pre-commit")], { cwd: root });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /partially staged file/);
	assert.doesNotMatch(git(root, "diff", "--cached"), /UNSTAGED-SECRET/);
});

test("tool stats encodes session strings as JSON data instead of executable markup", () => {
	const root = temporaryRoot("pi-tool-stats-");
	const sessions = join(root, "sessions");
	const output = join(root, "report.html");
	mkdirSync(sessions);
	const payload = "</script><script>globalThis.PWNED=true</script>";
	writeFileSync(join(sessions, "session.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: payload }] } })}\n`);
	const result = run(process.execPath, [join(repositoryRoot, "scripts/tool-stats.ts"), "--sessions-dir", sessions, "--output", output, "--no-open"], { cwd: repositoryRoot });
	assert.equal(result.status, 0, result.stderr);
	const html = readFileSync(output, "utf8");
	assert.doesNotMatch(html, /globalThis\.PWNED=true<\/script>/);
	assert.match(html, /\\u003c\/script>/);
});
