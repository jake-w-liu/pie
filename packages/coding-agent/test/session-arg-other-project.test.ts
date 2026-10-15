import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as readline from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";

/** Minimal readline interface: answers with `answer`, or closes like stdin at EOF when it is undefined. */
class FakeInterface {
	answer: string | undefined;
	private closeHandlers: Array<() => void> = [];

	constructor(answer: string | undefined) {
		this.answer = answer;
	}

	once(event: string, handler: () => void): this {
		if (event === "close") this.closeHandlers.push(handler);
		return this;
	}

	question(_query: string, callback: (answer: string) => void): void {
		if (this.answer === undefined) this.close();
		else callback(this.answer);
	}

	close(): void {
		for (const handler of this.closeHandlers.splice(0)) handler();
	}
}

const createInterface = vi.hoisted(() => vi.fn());
vi.mock("node:readline", async (importOriginal) => ({
	...(await importOriginal<typeof readline>()),
	createInterface,
}));

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	createInterface.mockReset();
	vi.restoreAllMocks();
});

const SESSION_ID = "01a13b43-6759-7000-8000-000000000001";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-session-arg-other-project-"));
	tempDirs.push(root);
	const projectDir = join(root, "project");
	const otherProjectDir = join(root, "other-project");
	const sessionDir = join(root, "sessions");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	writeFileSync(
		join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${SESSION_ID}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp, cwd: otherProjectDir })}\n`,
	);
	const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`exit:${code}`);
	}) as typeof process.exit);
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	return { projectDir, sessionDir, exit, error };
}

describe("--session for a session from another project", () => {
	it.each(["print", "json", "rpc"] as const)("fails without reading stdin in %s mode", async (appMode) => {
		const { projectDir, sessionDir, error } = setup();
		createInterface.mockImplementation(() => new FakeInterface("n"));
		const parsed = parseArgs(["--session", SESSION_ID.slice(0, 13), "summarize the repo"]);

		await expect(
			createSessionManager(parsed, projectDir, sessionDir, SettingsManager.inMemory(), appMode),
		).rejects.toThrow("exit:1");

		expect(createInterface).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(expect.stringContaining(`--fork ${SESSION_ID.slice(0, 13)}`));
	});

	it("treats end of input at the interactive fork question as no", async () => {
		const { projectDir, sessionDir } = setup();
		createInterface.mockImplementation(() => new FakeInterface(undefined));
		const parsed = parseArgs(["--session", SESSION_ID]);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([
			createSessionManager(parsed, projectDir, sessionDir, SettingsManager.inMemory(), "interactive").then(
				() => "resolved",
				(cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
			),
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve("still waiting for an answer"), 5_000);
			}),
		]);
		clearTimeout(timer);

		expect(outcome).toBe("exit:0");
		expect(createInterface).toHaveBeenCalledTimes(1);
	});
});
