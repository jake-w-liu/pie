import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateAuthToAuthJson, migrateSessionsFromAgentRoot } from "../src/migrations.ts";

describe("audit migration fixes (P5/P6)", () => {
	const tempDirs: string[] = [];
	let previousAgentDir: string | undefined;

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		previousAgentDir = undefined;
	});

	function useAgentDir(): string {
		const agentDir = join(tmpdir(), `pi-audit-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		if (previousAgentDir === undefined) {
			previousAgentDir = process.env[ENV_AGENT_DIR];
		}
		process.env[ENV_AGENT_DIR] = agentDir;
		return agentDir;
	}

	function readJson(file: string): Record<string, unknown> {
		return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
	}

	describe("P5: migrateAuthToAuthJson", () => {
		it("writes auth.json before stripping settings so credentials are never lost", () => {
			const agentDir = useAgentDir();
			writeFileSync(
				join(agentDir, "oauth.json"),
				JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 123 } }),
			);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ apiKeys: { openai: "sk-test" } }));

			const providers = migrateAuthToAuthJson();
			expect(new Set(providers)).toEqual(new Set(["anthropic", "openai"]));

			const auth = readJson(join(agentDir, "auth.json"));
			expect(auth.anthropic).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 123 });
			expect(auth.openai).toEqual({ type: "api_key", key: "sk-test" });
			expect(existsSync(join(agentDir, "oauth.json"))).toBe(false);
			expect(existsSync(join(agentDir, "oauth.json.migrated"))).toBe(true);
			expect("apiKeys" in readJson(join(agentDir, "settings.json"))).toBe(false);
		});

		it("retries migration when auth.json is an empty leftover partial write", () => {
			const agentDir = useAgentDir();
			writeFileSync(join(agentDir, "auth.json"), "");
			writeFileSync(
				join(agentDir, "oauth.json"),
				JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 123 } }),
			);

			const providers = migrateAuthToAuthJson();
			expect(providers).toEqual(["anthropic"]);
			expect(readJson(join(agentDir, "auth.json")).anthropic).toEqual({
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: 123,
			});
		});

		it("backs up corrupt auth.json and recovers credentials from oauth.json", () => {
			const agentDir = useAgentDir();
			writeFileSync(join(agentDir, "auth.json"), "{corrupt!!!");
			writeFileSync(
				join(agentDir, "oauth.json"),
				JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 123 } }),
			);

			const providers = migrateAuthToAuthJson();
			expect(providers).toEqual(["anthropic"]);
			expect(readJson(join(agentDir, "auth.json")).anthropic).toBeDefined();
			const leftovers = readdirSync(agentDir).filter((name) => name.startsWith("auth.json.corrupt-"));
			expect(leftovers).toHaveLength(1);
		});

		it("preserves existing credentials and lets them win on conflict", () => {
			const agentDir = useAgentDir();
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "keep" } }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ apiKeys: { openai: "sk-new" } }));

			const providers = migrateAuthToAuthJson();
			expect(providers).toEqual([]);
			expect(readJson(join(agentDir, "auth.json")).openai).toEqual({ type: "api_key", key: "keep" });
			// Legacy copy is still cleaned up since the credential is safe.
			expect("apiKeys" in readJson(join(agentDir, "settings.json"))).toBe(false);
		});

		it("does nothing when there is nothing to migrate", () => {
			const agentDir = useAgentDir();
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "k" } }));
			expect(migrateAuthToAuthJson()).toEqual([]);
			expect(readJson(join(agentDir, "auth.json")).openai).toEqual({ type: "api_key", key: "k" });
		});
	});

	describe("P6: migrateSessionsFromAgentRoot", () => {
		function sessionFile(agentDir: string, name: string, cwd: string, extra = ""): string {
			const file = join(agentDir, name);
			writeFileSync(
				file,
				`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2025-01-01T00:00:00Z", cwd })}\n${extra}`,
			);
			return file;
		}

		function targetDir(agentDir: string, cwd: string): string {
			return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		}

		it("moves a session into its per-cwd directory", () => {
			const agentDir = useAgentDir();
			sessionFile(agentDir, "a.jsonl", "/proj/foo");
			migrateSessionsFromAgentRoot();
			expect(existsSync(join(agentDir, "a.jsonl"))).toBe(false);
			expect(existsSync(join(targetDir(agentDir, "/proj/foo"), "a.jsonl"))).toBe(true);
		});

		it("dedupes instead of stranding the source when the target already exists", () => {
			const agentDir = useAgentDir();
			const source = sessionFile(agentDir, "dup.jsonl", "/proj/foo");
			const sourceContent = readFileSync(source, "utf-8");
			const dir = targetDir(agentDir, "/proj/foo");
			mkdirSync(dir, { recursive: true });
			// Identical content: source is a leftover duplicate.
			writeFileSync(join(dir, "dup.jsonl"), sourceContent);

			migrateSessionsFromAgentRoot();
			expect(existsSync(source)).toBe(false);
			expect(readFileSync(join(dir, "dup.jsonl"), "utf-8")).toBe(sourceContent);
		});

		it("preserves divergent content under a unique name instead of stranding it", () => {
			const agentDir = useAgentDir();
			const source = sessionFile(agentDir, "clash.jsonl", "/proj/foo", '{"type":"label","id":"x"}\n');
			const dir = targetDir(agentDir, "/proj/foo");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "clash.jsonl"), "different content\n");

			migrateSessionsFromAgentRoot();
			expect(existsSync(source)).toBe(false);
			expect(readFileSync(join(dir, "clash.jsonl"), "utf-8")).toBe("different content\n");
			const duplicates = readdirSync(dir).filter((name) => name.startsWith("clash.jsonl.duplicate"));
			expect(duplicates).toHaveLength(1);
			expect(readFileSync(join(dir, duplicates[0]), "utf-8")).toContain('"type":"label"');
		});
	});
});
