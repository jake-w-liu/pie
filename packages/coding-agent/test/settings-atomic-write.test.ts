import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";

describe("audit settings atomic write (P7)", () => {
	let agentDir: string;
	let projectDir: string;

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function setup(): FileSettingsStorage {
		const root = mkdtempSync(join(tmpdir(), "pi-audit-settings-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "proj");
		return new FileSettingsStorage(projectDir, agentDir);
	}

	it("round-trips settings content", () => {
		const storage = setup();
		storage.withLock("global", () => JSON.stringify({ theme: "dark" }));
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(JSON.stringify({ theme: "dark" }));
	});

	it("read-modify-write sees the latest content", () => {
		const storage = setup();
		storage.withLock("global", () => JSON.stringify({ count: 1 }));
		storage.withLock("global", (current) => {
			const parsed = JSON.parse(current ?? "{}") as { count: number };
			return JSON.stringify({ count: parsed.count + 1 });
		});
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({ count: 2 });
	});

	it("leaves no temp files behind", () => {
		const storage = setup();
		storage.withLock("global", () => JSON.stringify({ a: 1 }));
		storage.withLock("global", (current) => `${current}`);
		expect(readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
