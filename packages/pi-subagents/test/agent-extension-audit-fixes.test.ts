import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentMemoryInjection } from "../src/agents/agent-memory.ts";
import { handleManagementAction } from "../src/agents/agent-management.ts";
import { discoverAgents, discoverAgentsAll } from "../src/agents/agents.ts";
import { parseFrontmatter, parseFrontmatterList } from "../src/agents/frontmatter.ts";
import { registerRuntimeAgent } from "../src/agents/runtime-agent-registry.ts";
import { resolveSkills } from "../src/agents/skills.ts";
import { getProviderModelsPath, getSubagentProfilesDir, readProviderModelCatalog, readSubagentProfile } from "../src/profiles/profiles.ts";
import { discoverPromptWorkflows, substituteArgs } from "../src/slash/prompt-workflows.ts";

const roots: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	process.env = { ...originalEnv };
});

function sandbox(): { root: string; agentDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-fixes-"));
	roots.push(root);
	const agentDir = path.join(root, "home", ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	process.env.HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	return { root, agentDir };
}

function writeAgent(file: string, name: string, description = name, extra = ""): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\nbody\n`);
}

const ctx = (cwd: string) => ({ cwd, modelRegistry: { getAvailable: () => [] } }) as never;
const text = (result: ReturnType<typeof handleManagementAction>) => (result.content[0] as { text: string }).text;

describe("agent extension audit regressions", () => {
	it("rejects profile overrides discovery would reject", () => {
		sandbox();
		const profiles = getSubagentProfilesDir();
		fs.mkdirSync(profiles, { recursive: true });
		fs.writeFileSync(path.join(profiles, "bad.json"), JSON.stringify({ subagents: { agentOverrides: { worker: { tools: "read,bash" } } } }));
		expect(() => readSubagentProfile("bad")).toThrow(/invalid 'tools'/);
	});

	it("treats empty and comment-only frontmatter as an empty mapping", () => {
		expect(parseFrontmatter("---\n---\nSay $ARGUMENTS now.\n")).toEqual({
			frontmatter: {},
			body: "Say $ARGUMENTS now.",
		});
		expect(parseFrontmatter("---\n# comment\n---\nbody\n")).toEqual({ frontmatter: {}, body: "body" });
	});

	it("discovers prompt workflows when one prompt file is malformed", () => {
		const { root, agentDir } = sandbox();
		const prompts = path.join(agentDir, "prompts");
		fs.mkdirSync(prompts, { recursive: true });
		fs.writeFileSync(path.join(prompts, "probe-broken.md"), "---\nkey: [unclosed\n---\nbody\n");
		fs.writeFileSync(path.join(prompts, "probe-good.md"), "---\ndescription: good\n---\nRun $ARGUMENTS\n");

		expect(discoverPromptWorkflows(root).map((workflow) => workflow.name)).toContain("probe-good");
	});

	it("preserves YAML sequences and blank lines in policy mappings", () => {
		const parsed = parseFrontmatter("---\nname: x\ntools:\n- read\n- bash\npermissions:\n  write: deny\n\n  edit: deny\n---\nbody\n");
		expect(parseFrontmatterList(parsed.frontmatter.tools)).toEqual(["read", "bash"]);
		expect(parsed.frontmatter.permissions).toContain("edit: deny");
	});

	it("does not materialize inherited defaults during an unrelated update", () => {
		const { root, agentDir } = sandbox();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { defaultModel: "vendor/old", defaultThinking: "high" } }));
		const file = path.join(agentDir, "agents", "helper.md");
		writeAgent(file, "helper", "old");
		handleManagementAction("update", { action: "update", agent: "helper", config: { description: "new" } }, ctx(root));
		expect(fs.readFileSync(file, "utf-8")).not.toMatch(/^(model|thinking):/m);
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { defaultModel: "vendor/new" } }));
		expect(discoverAgents(root, "both").agents.find((agent) => agent.name === "helper")?.model).toBe("vendor/new");
	});

	it("requires a scope for update, delete, and reset when user and project copies both exist", () => {
		const { root, agentDir } = sandbox();
		const userFile = path.join(agentDir, "agents", "worker.md");
		const projectFile = path.join(root, ".pi", "agents", "worker.md");
		writeAgent(userFile, "worker", "user original");
		writeAgent(projectFile, "worker", "project original");

		const attempts = [
			{ action: "update", config: { description: "should not change" } },
			{ action: "delete" },
			{ action: "reset" },
		] as const;
		for (const attempt of attempts) {
			const result = handleManagementAction(attempt.action, { ...attempt, agent: "worker" }, ctx(root));
			expect(result.isError, attempt.action).toBe(true);
			expect(text(result), attempt.action).toContain("exists in both scopes");
			expect(fs.readFileSync(userFile, "utf-8"), attempt.action).toContain("description: user original");
			expect(fs.readFileSync(projectFile, "utf-8"), attempt.action).toContain("description: project original");
		}

		const update = handleManagementAction("update", { action: "update", agent: "worker", agentScope: "user", config: { description: "user updated" } }, ctx(root));
		expect(update.isError).toBeFalsy();
		expect(fs.readFileSync(userFile, "utf-8")).toContain("description: user updated");
		expect(fs.readFileSync(projectFile, "utf-8")).toContain("description: project original");

		const reset = handleManagementAction("reset", { action: "reset", agent: "worker", agentScope: "user" }, ctx(root));
		expect(reset.isError).toBeFalsy();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(true);

		const deletion = handleManagementAction("delete", { action: "delete", agent: "worker", agentScope: "project" }, ctx(root));
		expect(deletion.isError).toBeFalsy();
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("accepts depth zero and diagnoses malformed configured depth", () => {
		const pi = { on() {}, registerTool() {} } as never;
		expect(() => registerRuntimeAgent({ pi, name: "zero", definition: { description: "zero", systemPrompt: "body", maxSubagentDepth: 0 } })).not.toThrow();
		const { root } = sandbox();
		writeAgent(path.join(root, ".pi", "agents", "bad.md"), "bad", "bad", "maxSubagentDepth: nope\n");
		const discovered = discoverAgents(root, "both");
		expect(discovered.agents.some((agent) => agent.name === "bad")).toBe(false);
		expect(discovered.agentDiagnostics?.some((diagnostic) => diagnostic.error.includes("maxSubagentDepth"))).toBe(true);
	});

	it("substitutes arguments literally in one pass", () => {
		expect(substituteArgs("Explain $ARGUMENTS / $1", ["$1 $ARGUMENTS $& $$ \\path"])).toBe("Explain $1 $ARGUMENTS $& $$ \\path / $1 $ARGUMENTS $& $$ \\path");
	});

	it("reports duplicate definitions from raw all-scope sources", () => {
		const { root } = sandbox();
		writeAgent(path.join(root, ".pi", "agents", "a", "foo.md"), "foo");
		writeAgent(path.join(root, ".pi", "agents", "b", "foo.md"), "foo");
		const diagnostics = discoverAgentsAll(root).agentDiagnostics ?? [];
		expect(diagnostics.filter((diagnostic) => diagnostic.error.startsWith("Duplicate agent name"))).toHaveLength(2);
	});

	it("uses the configured project root for skills and memory from nested cwd", () => {
		const { root } = sandbox();
		const repo = path.join(root, "repo");
		const nested = path.join(repo, "packages", "app");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(path.join(nested, ".pi", "prompts"), { recursive: true });
		fs.mkdirSync(path.join(repo, ".pi", "skills", "root-skill"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
		fs.writeFileSync(path.join(repo, ".pi", "skills", "root-skill", "SKILL.md"), "---\nname: root-skill\ndescription: root\n---\nskill\n");
		writeAgent(path.join(repo, ".pi", "agents", "worker.md"), "root-worker", "root", "skills: root-skill\nmemory: { scope: project, path: worker }\n");
		fs.mkdirSync(path.join(repo, ".pi", "agent-memory", "worker"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".pi", "agent-memory", "worker", "MEMORY.md"), "ROOT NOTE");
		const agent = discoverAgents(nested, "both").agents.find((entry) => entry.name === "root-worker")!;
		expect(resolveSkills(agent.skills ?? [], nested).resolved.map((skill) => skill.name)).toContain("root-skill");
		expect(buildAgentMemoryInjection(agent, nested)).toContain("ROOT NOTE");
	});

	it("rejects malformed provider catalog model records", () => {
		sandbox();
		const file = getProviderModelsPath("fake");
		fs.writeFileSync(file, JSON.stringify({ provider: "fake", refreshedAt: new Date().toISOString(), maxAgeDays: 7, sources: [], models: [{ id: "x", fullId: "fake/x", observed: { availableInRegistry: true } }] }));
		expect(readProviderModelCatalog("fake")).toBeNull();
	});

	it("creates a writable user override when only an extra definition exists", () => {
		const { root, agentDir } = sandbox();
		const extraFile = path.join(root, "extra", "foo.md");
		writeAgent(extraFile, "foo", "extra");
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = path.dirname(extraFile);

		const result = handleManagementAction("create", {
			action: "create",
			config: { name: "foo", description: "user", scope: "user" },
		}, ctx(root));

		expect(result.isError).toBeFalsy();
		expect(fs.readFileSync(path.join(agentDir, "agents", "foo.md"), "utf-8")).toContain("description: user");
		expect(fs.readFileSync(extraFile, "utf-8")).toContain("description: extra");
	});

	it("ejects a writable user override alongside an extra definition", () => {
		const { root, agentDir } = sandbox();
		const extraFile = path.join(root, "extra", "worker.md");
		writeAgent(extraFile, "worker", "extra");
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = path.dirname(extraFile);

		const result = handleManagementAction("eject", { action: "eject", agent: "worker", agentScope: "user" }, ctx(root));

		expect(result.isError).toBeFalsy();
		expect(fs.existsSync(path.join(agentDir, "agents", "worker.md"))).toBe(true);
		expect(fs.readFileSync(extraFile, "utf-8")).toContain("description: extra");
	});

	it("resets a writable user override before a same-named extra definition", () => {
		const { root, agentDir } = sandbox();
		const extraFile = path.join(root, "extra", "worker.md");
		const userFile = path.join(agentDir, "agents", "worker.md");
		writeAgent(extraFile, "worker", "extra");
		writeAgent(userFile, "worker", "user");
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = path.dirname(extraFile);

		const result = handleManagementAction("reset", { action: "reset", agent: "worker", agentScope: "user" }, ctx(root));

		expect(result.isError).toBeFalsy();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.readFileSync(extraFile, "utf-8")).toContain("description: extra");
	});

	it("never mutates definitions from read-only extra agent directories", () => {
		const { root } = sandbox();
		const extra = path.join(root, "extra");
		const file = path.join(extra, "worker.md");
		writeAgent(file, "worker");
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = extra;
		const result = handleManagementAction("reset", { action: "reset", agent: "worker", agentScope: "user" }, ctx(root));
		expect(result.isError).toBe(true);
		expect(fs.existsSync(file)).toBe(true);
	});
});
