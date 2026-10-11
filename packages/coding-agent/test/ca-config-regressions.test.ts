import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { Extension } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills } from "../src/core/skills.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

describe("configuration audit regressions", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let oldHome: string | undefined;
	let oldCwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pie-config-regression-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		oldHome = process.env.HOME;
		oldCwd = process.cwd();
		process.env.HOME = root;
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.chdir(oldCwd);
		process.exitCode = undefined;
		vi.restoreAllMocks();
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(root, { recursive: true, force: true });
	});

	function makeExtensionPackage(dir: string, entries: string[]): void {
		mkdirSync(join(dir, "extensions"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-package", pi: { extensions: entries } }));
		writeFileSync(join(dir, "extensions", "alpha.ts"), "export default function () {}\n");
		writeFileSync(join(dir, "extensions", "beta.ts"), "export default function () {}\n");
	}

	it("rebuilds extension runtime state after project trust changes precedence", async () => {
		const writePackage = (dir: string, label: string) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "shared", version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
			);
			writeFileSync(
				join(dir, "index.ts"),
				`export default function (pi) {
	pi.registerFlag("shared-mode", { type: "string", default: "${label}" });
	pi.events.on("audit-ping", () => globalThis.__pieAuditEvents.push("${label}"));
}\n`,
			);
		};
		writePackage(join(agentDir, "npm", "node_modules", "shared"), "USER");
		writePackage(join(cwd, ".pi", "npm", "node_modules", "shared"), "PROJECT");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:shared"] }));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:shared"] }));
		const events: string[] = [];
		(globalThis as typeof globalThis & { __pieAuditEvents: string[] }).__pieAuditEvents = events;
		const eventBus = createEventBus();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			eventBus,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		});
		await loader.reload({ resolveProjectTrust: async () => true });
		expect(loader.getExtensions().runtime.flagValues.get("shared-mode")).toBe("PROJECT");
		eventBus.emit("audit-ping", {});
		expect(events).toEqual(["PROJECT"]);
		delete (globalThis as typeof globalThis & { __pieAuditEvents?: string[] }).__pieAuditEvents;
	});

	it.each([["./extensions"], ["./extensions/*.ts"]])(
		"expands manifest extension entry %s from top-level settings",
		async (entry) => {
			const packageDir = join(root, "package");
			makeExtensionPackage(packageDir, [entry]);
			const manager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ extensions: [packageDir] }),
			});
			const resolved = await manager.resolve();
			expect(resolved.extensions.map((resource) => resource.path).sort()).toEqual([
				join(packageDir, "extensions", "alpha.ts"),
				join(packageDir, "extensions", "beta.ts"),
			]);
		},
	);

	it("uses positive settings globs as discovery sources for every resource type", async () => {
		const extensionDir = join(agentDir, "custom-extensions");
		const skillDir = join(agentDir, "custom-skills", "one");
		const promptDir = join(agentDir, "custom-prompts");
		const themeDir = join(agentDir, "custom-themes");
		for (const dir of [extensionDir, skillDir, promptDir, themeDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(extensionDir, "one.ts"), "export default function () {}\n");
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: one\ndescription: one\n---\n");
		writeFileSync(join(promptDir, "one.md"), "prompt\n");
		writeFileSync(join(themeDir, "one.json"), "{}\n");
		const manager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({
				extensions: ["custom-extensions/*.ts"],
				skills: ["custom-skills/*/SKILL.md"],
				prompts: ["custom-prompts/*.md"],
				themes: ["custom-themes/*.json"],
			}),
		});
		const resolved = await manager.resolve();
		expect(resolved.extensions.some((entry) => entry.path === join(extensionDir, "one.ts"))).toBe(true);
		expect(resolved.skills.some((entry) => entry.path === join(skillDir, "SKILL.md"))).toBe(true);
		expect(resolved.prompts.some((entry) => entry.path === join(promptDir, "one.md"))).toBe(true);
		expect(resolved.themes.some((entry) => entry.path === join(themeDir, "one.json"))).toBe(true);
	});

	it("merges package additions from stale manager snapshots", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:existing"] }));
		const firstSettings = SettingsManager.create(cwd, agentDir);
		const secondSettings = SettingsManager.create(cwd, agentDir);
		new DefaultPackageManager({ cwd, agentDir, settingsManager: firstSettings }).addSourceToSettings("./first");
		await firstSettings.flush();
		new DefaultPackageManager({ cwd, agentDir, settingsManager: secondSettings }).addSourceToSettings("./second");
		await secondSettings.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).packages).toEqual([
			"npm:existing",
			"../project/first",
			"../project/second",
		]);
	});

	it("fails package installation before reporting success when settings are invalid", async () => {
		const cliAgentDir = join(root, ".pi", "agent");
		mkdirSync(cliAgentDir, { recursive: true });
		writeFileSync(join(cliAgentDir, "settings.json"), '{ "theme": "dark", }\n');
		process.chdir(cwd);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args) => output.push(args.join(" ")));
		await handlePackageCommand(["install", "./extension"]);
		expect(process.exitCode).toBe(1);
		expect(output.some((line) => line.includes("Installed ./extension"))).toBe(false);
	});

	it("canonicalizes modifier order when checking shortcut conflicts", () => {
		const fakeExtension = (path: string, keys: string[]): Extension =>
			({
				path,
				resolvedPath: path,
				handlers: new Map(),
				tools: new Map(),
				messageRenderers: new Map(),
				entryRenderers: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(keys.map((key) => [key, { shortcut: key, extensionPath: path, handler: () => {} }])),
				sourceInfo: { source: path, scope: "temporary", origin: "top-level" },
			}) as unknown as Extension;
		const runner = new ExtensionRunner(
			[fakeExtension("/first.ts", ["ctrl+shift+p", "shift+ctrl+x"]), fakeExtension("/second.ts", ["ctrl+shift+x"])],
			{} as never,
			cwd,
			{} as never,
			{} as never,
		);
		const shortcuts = runner.getShortcuts(new KeybindingsManager({}).getEffectiveConfig());
		expect([...shortcuts.keys()]).toEqual(["ctrl+shift+x"]);
		expect(runner.getShortcutDiagnostics()).toHaveLength(2);
	});

	it("applies slashless nested ignore rules at every descendant level", async () => {
		const skillsDir = join(agentDir, "skills");
		for (const path of ["vendor/draft", "vendor/pack/draft", "vendor/pack/real"]) {
			mkdirSync(join(skillsDir, path), { recursive: true });
			writeFileSync(
				join(skillsDir, path, "SKILL.md"),
				`---\nname: ${path.replaceAll("/", "-")}\ndescription: test\n---\n`,
			);
		}
		writeFileSync(join(skillsDir, "vendor", ".gitignore"), "draft/\n");
		const resolved = await new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
		}).resolve();
		expect(resolved.skills.map((entry) => entry.path)).toEqual([join(skillsDir, "vendor/pack/real/SKILL.md")]);
		expect(loadSkills({ cwd, agentDir, skillPaths: [skillsDir], includeDefaults: false }).skills).toHaveLength(1);
	});

	it("lets an explicit top-level resource override disabled package metadata", async () => {
		const packageDir = join(root, "package");
		makeExtensionPackage(packageDir, ["./extensions/*.ts"]);
		const extension = join(packageDir, "extensions", "alpha.ts");
		const resolved = await new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({
				packages: [{ source: packageDir, autoload: false }],
				extensions: [extension],
			}),
		}).resolve();
		const resource = resolved.extensions.find((entry) => entry.path === extension);
		expect(resource).toMatchObject({ enabled: true, metadata: { origin: "top-level" } });
	});

	it("requires trust for lexical ancestor skills reached through a symlinked cwd", () => {
		const realProject = join(root, "real", "project");
		const aliasRoot = join(root, "alias");
		mkdirSync(realProject, { recursive: true });
		mkdirSync(join(aliasRoot, ".agents", "skills", "unsafe"), { recursive: true });
		symlinkSync(realProject, join(aliasRoot, "work"));
		expect(hasTrustRequiringProjectResources(join(aliasRoot, "work"))).toBe(true);
	});
});
