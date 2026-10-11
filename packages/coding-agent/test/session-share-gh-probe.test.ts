import type * as ChildProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ShareContext = Parameters<typeof shareSession>[0];

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
	};
});

/**
 * shareSession probes `gh auth status` synchronously on the TUI thread. gh can
 * block on network I/O or a credential helper, so the probe needs a deadline,
 * and the three ways it can fail (missing binary, not logged in, hung) must not
 * collapse into the same message.
 */
describe("shareSession gh auth probe", () => {
	afterEach(() => {
		vi.mocked(spawnSync).mockReset();
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
	});

	function makeContext(errors: string[]): ShareContext {
		const session = {
			sessionManager: {
				getSessionId: () => "session-id",
				getCwd: () => process.cwd(),
				getBranch: () => [],
			},
			state: { systemPrompt: "system", tools: [] },
			modelRuntime: { getProvider: () => undefined },
		} as unknown as AgentSession;

		return {
			session,
			ui: {} as never,
			editorContainer: {} as never,
			editor: {} as never,
			showStatus: () => {},
			showError: (message: string) => errors.push(message),
		};
	}

	it("bounds the gh probe with a timeout so it cannot freeze the TUI", async () => {
		const errors: string[] = [];
		const context = makeContext(errors);

		await shareSession(context);

		const ghCall = vi.mocked(spawnSync).mock.calls.find((call) => call[0] === "gh");
		expect(ghCall).toBeDefined();
		const options = ghCall?.[2] as { timeout?: number } | undefined;
		expect(options?.timeout).toBeGreaterThan(0);
	});

	it("reports a missing gh binary instead of claiming the user is not logged in", async () => {
		vi.mocked(spawnSync).mockReturnValue({
			status: null,
			signal: null,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
		} as never);
		const errors: string[] = [];

		await shareSession(makeContext(errors));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("is not installed");
		expect(errors[0]).not.toContain("not logged in");
	});

	it("reports a hung gh probe as a timeout", async () => {
		vi.mocked(spawnSync).mockReturnValue({
			status: null,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }),
		} as never);
		const errors: string[] = [];

		await shareSession(makeContext(errors));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/did not respond within \d+ms/);
	});

	it("still reports a non-zero auth status as a login problem", async () => {
		vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "not logged in" } as never);
		const errors: string[] = [];

		await shareSession(makeContext(errors));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("not logged in");
	});
});

/**
 * Every share writes the session out to disk before uploading it. A fixed
 * $TMPDIR name collides with any other share running at the same time (two
 * processes overwrite each other's bytes, and the first to finish deletes the
 * file the other is still uploading) and is predictable enough to be pre-created
 * as a symlink by another local user. Each share gets its own private directory.
 */
describe("shareSession temp files", () => {
	afterEach(() => {
		vi.mocked(spawnSync).mockReset();
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
	});

	function makeContext(htmlPaths: string[]): ShareContext {
		const session = {
			sessionManager: {
				getSessionId: () => "session-id",
				getCwd: () => process.cwd(),
				getBranch: () => [],
			},
			state: { systemPrompt: "system", tools: [] },
			modelRuntime: { getProvider: () => undefined },
			exportToHtml: async (target: string) => {
				htmlPaths.push(target);
				// Stop before the gist upload; this test is about the temp path.
				throw new Error("stop after capture");
			},
		} as unknown as AgentSession;

		return {
			session,
			ui: {} as never,
			editorContainer: {} as never,
			editor: {} as never,
			showStatus: () => {},
			showError: () => {},
		};
	}

	it("exports each share into its own temporary directory and cleans it up", async () => {
		initTheme("dark");
		const htmlPaths: string[] = [];

		await Promise.all([shareSession(makeContext(htmlPaths)), shareSession(makeContext(htmlPaths))]);

		expect(htmlPaths).toHaveLength(2);
		const directories = htmlPaths.map((file) => path.dirname(file));
		expect(new Set(directories).size).toBe(2);
		for (const directory of directories) {
			expect(path.basename(directory)).toMatch(/^pi-share-/);
			expect(path.dirname(directory)).toBe(os.tmpdir());
		}
		for (const directory of directories) {
			expect(fs.existsSync(directory)).toBe(false);
		}
	});
});
