import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const sampleSkill = {
	name: "s",
	description: "d",
	filePath: "/x/s.md",
	baseDir: "/x",
	sourceInfo: { path: "/x/s.md", source: "settings", scope: "project", origin: "top-level" } as const,
	disableModelInvocation: false,
} as const;

describe("buildSystemPrompt", () => {
	describe("cache stability", () => {
		test("outputs are deterministic for identical inputs (byte-stable cache prefix)", () => {
			const options = {
				selectedTools: ["read", "bash", "edit", "write"],
				contextFiles: [{ path: "/proj/AGENTS.md", content: "project rules" }],
				skills: [sampleSkill],
				cwd: "/proj",
			};
			const first = buildSystemPrompt(options);
			const second = buildSystemPrompt(options);
			expect(first).toBe(second);
		});

		test("keeps volatile working directory content at the very end of the prompt", () => {
			const cwd = "/proj/alpha-beta";
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [{ path: "/proj/AGENTS.md", content: "rules" }],
				skills: [sampleSkill],
				cwd,
			});
			expect(prompt.endsWith(`Current working directory: ${cwd}`)).toBe(true);
			expect(prompt.indexOf("Current working directory")).toBe(
				prompt.length - `Current working directory: ${cwd}`.length,
			);
		});
	});

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("ponytail minimal-change guide", () => {
		test("is always present regardless of tool set", () => {
			for (const selectedTools of [["read"], ["read", "bash", "edit", "write"], ["grep", "find", "ls"]]) {
				const prompt = buildSystemPrompt({
					selectedTools,
					contextFiles: [],
					skills: [],
					cwd: process.cwd(),
				});
				expect(prompt).toContain("Build only what the request asks for");
				expect(prompt).toContain("Reuse before writing");
				expect(prompt).toContain("Prefer the smallest change that works");
				expect(prompt).toContain("Never trade correctness, robustness, or error handling for brevity");
			}
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
