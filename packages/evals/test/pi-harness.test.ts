import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";

const roots = new Set<string>();
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
	roots.clear();
});

async function skill(path: string, name: string, description: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`);
}

describe("Pi eval resource isolation", () => {
	it.each([false, true])(
		"keeps host resources out on initial load and reload (transformed/no-tools: %s)",
		async (transformed) => {
			const root = await mkdtemp(join(tmpdir(), "pi-eval-isolation-"));
			roots.add(root);
			const home = join(root, "home");
			const temp = join(root, "temp");
			const sharedAgent = join(home, ".pi", "agent");
			await mkdir(temp, { recursive: true });
			await mkdir(sharedAgent, { recursive: true });
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			vi.stubEnv("TMPDIR", temp);
			vi.stubEnv("TMP", temp);
			vi.stubEnv("TEMP", temp);
			vi.stubEnv("PI_CODING_AGENT_DIR", sharedAgent);
			vi.stubEnv("PIE_CODING_AGENT_DIR", sharedAgent);
			vi.stubEnv("PI_OFFLINE", "1");
			const fetch = vi.fn(() => {
				throw new Error("Unexpected network access");
			});
			vi.stubGlobal("fetch", fetch);
			await skill(join(home, ".agents", "skills", "host-skill", "SKILL.md"), "host-skill", "HOST-HOME-SENTINEL");
			await skill(
				join(temp, ".agents", "skills", "ancestor-skill", "SKILL.md"),
				"ancestor-skill",
				"HOST-ANCESTOR-SENTINEL",
			);
			await writeFile(join(temp, "AGENTS.md"), "HOST-CONTEXT-SENTINEL");
			const authPath = join(sharedAgent, "auth.json");
			const credentials = JSON.stringify({
				"fixture-credential": { type: "api_key", key: "intentional-test-credential" },
			});
			await writeFile(authPath, credentials);
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("created"), fauxAssistantMessage("reloaded")]);
			const create = ModelRuntime.create.bind(ModelRuntime);
			let sharedCredentials = false;
			const createRuntime = vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
				const runtime = await create(options);
				sharedCredentials = (await runtime.listCredentials()).some(
					({ providerId }) => providerId === "fixture-credential",
				);
				runtime.registerNativeProvider(faux.provider);
				await runtime.refresh({ allowNetwork: false });
				return runtime;
			});
			const observations: Array<{ prompt: string; skills: string[]; contexts: string[] }> = [];
			const prompt = AgentSession.prototype.prompt;
			let workspace = "";
			vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
				this: AgentSession,
				...args: Parameters<AgentSession["prompt"]>
			) {
				workspace = this.sessionManager.getCwd();
				observations.push({
					prompt: this.systemPrompt,
					skills: this.resourceLoader.getSkills().skills.map(({ name }) => name),
					contexts: this.resourceLoader.getAgentsFiles().agentsFiles.map(({ content }) => content),
				});
				if (observations.length === 1) {
					await skill(join(workspace, ".pi", "skills", "host-skill", "SKILL.md"), "host-skill", "WORKSPACE-SKILL");
					await skill(
						join(workspace, ".agents", "skills", "project-skill", "SKILL.md"),
						"project-skill",
						"WORKSPACE-AGENTS-SKILL",
					);
					await skill(
						join(dirname(workspace), "agent", "skills", "ancestor-skill", "SKILL.md"),
						"ancestor-skill",
						"TEMP-AGENT-SKILL",
					);
					const sibling = join(dirname(workspace), "workspace-sibling");
					await skill(join(sibling, "external-skill", "SKILL.md"), "external-skill", "HOST-SYMLINK-SENTINEL");
					await symlink(join(sibling, "external-skill"), join(workspace, ".pi", "skills", "external-skill"));
					await symlink(join(temp, "AGENTS.md"), join(dirname(workspace), "agent", "AGENTS.md"));
					await writeFile(join(workspace, "AGENTS.md"), "WORKSPACE-CONTEXT");
					await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
					await writeFile(join(workspace, ".pi", "extensions", "local.ts"), "export default function () {}\n");
				}
				await prompt.apply(this, args);
			});
			const harness = createPiCodingAgentHarness({
				model: { provider: faux.getModel().provider, id: faux.getModel().id },
				...(transformed
					? { noTools: "all" as const, transformSystemPrompt: (value: string) => `TRANSFORMED\n${value}` }
					: {}),
				output: ({ response, session }) => ({ response, extensions: session.extensionRunner.getExtensionPaths() }),
			});
			const artifacts: HarnessContext["artifacts"] = {};
			const result = await harness.run(
				[
					{ type: "prompt", content: "Create resources" },
					{ type: "reload" },
					{ type: "prompt", content: "Inspect resources" },
				],
				{
					artifacts,
					setArtifact: (name, value) => {
						artifacts[name] = value;
					},
				},
			);
			expect(observations[0].skills).toEqual([]);
			expect(observations[0].contexts).toEqual([]);
			expect(observations[1].skills.sort()).toEqual(["ancestor-skill", "host-skill", "project-skill"]);
			expect(observations[1].contexts).toEqual(["WORKSPACE-CONTEXT"]);
			for (const observation of observations) expect(observation.prompt).not.toContain("HOST-");
			if (!transformed) {
				expect(observations[1].prompt).toContain("WORKSPACE-SKILL");
				expect(observations[1].prompt).toContain("TEMP-AGENT-SKILL");
			}
			expect(result.output?.extensions).toEqual([join(workspace, ".pi", "extensions", "local.ts")]);
			expect(result.output?.response).toBe("reloaded");
			expect(sharedCredentials).toBe(true);
			expect(createRuntime).toHaveBeenCalledWith();
			expect(await readFile(authPath, "utf8")).toBe(credentials);
			expect(existsSync(workspace)).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
