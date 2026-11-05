import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	lastOutputLines,
	resolvePieSourceCheckout,
	runPieUpdate,
	summarizePieUpdate,
} from "../src/modes/interactive/self-update.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pie-self-update-"));
	roots.push(root);
	return root;
}

function writeSourceMetadata(home: string, metadata: unknown): void {
	mkdirSync(join(home, ".local/share/pie"), { recursive: true });
	writeFileSync(
		join(home, ".local/share/pie/source.json"),
		typeof metadata === "string" ? metadata : JSON.stringify(metadata),
	);
}

function checkoutWithScript(root: string, script: string): string {
	const repository = join(root, "checkout");
	mkdirSync(join(repository, "scripts"), { recursive: true });
	writeFileSync(join(repository, "scripts/update-pie.sh"), script, { mode: 0o755 });
	return repository;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("resolvePieSourceCheckout", () => {
	it("explains how to bootstrap an installation without source metadata", () => {
		const result = resolvePieSourceCheckout(temporaryRoot());
		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.error).toContain("refresh:pie -- --no-bump");
	});

	it("reports unreadable metadata and metadata without a repository", () => {
		const home = temporaryRoot();
		writeSourceMetadata(home, "{not json");
		const unreadable = resolvePieSourceCheckout(home);
		expect(!unreadable.ok && unreadable.error).toContain("Could not read");

		writeSourceMetadata(home, { revision: "abc" });
		const missing = resolvePieSourceCheckout(home);
		expect(!missing.ok && missing.error).toContain("does not name a source checkout");
	});

	it("rejects a checkout that has no update script", () => {
		const home = temporaryRoot();
		writeSourceMetadata(home, { repository: join(home, "gone") });
		const result = resolvePieSourceCheckout(home);
		expect(!result.ok && result.error).toContain("predates /update");
	});

	it("finds the checkout the active installation was built from", () => {
		const home = temporaryRoot();
		const repository = checkoutWithScript(home, "#!/usr/bin/env bash\n");
		writeSourceMetadata(home, { repository, revision: "abc", dirty: false });
		expect(resolvePieSourceCheckout(home)).toEqual({
			ok: true,
			repository,
			updateScript: join(repository, "scripts/update-pie.sh"),
		});
	});
});

describe("runPieUpdate", () => {
	it.skipIf(process.platform === "win32")("captures output and the exit code", async () => {
		const root = temporaryRoot();
		const repository = checkoutWithScript(
			root,
			'#!/usr/bin/env bash\necho "Fetching main from origin..."\necho "warning: example" >&2\necho "Installed Pie 9.9.9 from abc"\nexit 0\n',
		);
		const chunks: string[] = [];
		const ok = await runPieUpdate(
			{ repository, updateScript: join(repository, "scripts/update-pie.sh") },
			{ onOutput: (chunk) => chunks.push(chunk) },
		);
		expect(ok.code).toBe(0);
		expect(ok.output).toContain("Installed Pie 9.9.9 from abc");
		expect(ok.output).toContain("warning: example");
		expect(chunks.join("")).toContain("Fetching main from origin...");

		const failing = checkoutWithScript(
			join(root, "failing"),
			'#!/usr/bin/env bash\necho "error: diverged" >&2\nexit 3\n',
		);
		const failed = await runPieUpdate({ repository: failing, updateScript: join(failing, "scripts/update-pie.sh") });
		expect(failed.code).toBe(3);
		expect(lastOutputLines(failed.output, 5)).toEqual(["error: diverged"]);
	});

	it.skipIf(process.platform === "win32")("decodes a character split across output chunks", async () => {
		const root = temporaryRoot();
		// "✓" is e2 9c 93 in UTF-8; the pause makes the two writes arrive as separate chunks.
		const repository = checkoutWithScript(
			root,
			"#!/usr/bin/env bash\nprintf '\\xe2\\x9c'\nsleep 0.3\nprintf '\\x93 done\\n'\n",
		);
		const chunks: string[] = [];
		const result = await runPieUpdate(
			{ repository, updateScript: join(repository, "scripts/update-pie.sh") },
			{ onOutput: (chunk) => chunks.push(chunk) },
		);
		expect(result.code).toBe(0);
		expect(result.output).toBe("✓ done\n");
		expect(chunks.join("")).toBe("✓ done\n");
	});

	it.skipIf(process.platform === "win32")("stops the whole process group when aborted", async () => {
		const root = temporaryRoot();
		const pidFile = join(root, "grandchild.pid");
		// The script starts a long-running grandchild, as npm or a build would.
		const repository = checkoutWithScript(
			root,
			`#!/usr/bin/env bash\nsleep 30 &\necho $! > "${pidFile}"\necho started\nwait\n`,
		);
		const controller = new AbortController();
		const run = runPieUpdate(
			{ repository, updateScript: join(repository, "scripts/update-pie.sh") },
			{
				signal: controller.signal,
				onOutput: (chunk) => {
					if (chunk.includes("started")) controller.abort();
				},
			},
		);
		const result = await run;
		expect(result.code === null || result.code !== 0).toBe(true);
		expect(existsSync(pidFile)).toBe(true);
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(isAlive(grandchild)).toBe(false);
	});
});

describe("lastOutputLines", () => {
	it("returns the last non-empty lines without terminal control sequences", () => {
		const output =
			"\u001b[32mFetching main\u001b[0m\n\n  building  \r\n\u001b[2K\u001b[1Aerror: \u0007failed\u001b]8;;https://x\u0007link\u001b]8;;\u0007\n";
		expect(lastOutputLines(output, 5)).toEqual(["Fetching main", "  building", "error: failedlink"]);
		expect(lastOutputLines(output, 1)).toEqual(["error: failedlink"]);
	});

	it("treats a bare carriage return as a line break, so progress shows its latest state", () => {
		expect(lastOutputLines("progress 10%\rprogress 55%\rprogress 90%", 1)).toEqual(["progress 90%"]);
		expect(lastOutputLines("a\r\nb\rc\n", 3)).toEqual(["a", "b", "c"]);
	});
});

describe("summarizePieUpdate", () => {
	it("reports the installed version or that Pie is already current", () => {
		expect(summarizePieUpdate("Fetching...\nInstalled Pie 0.1.3 from abc123\nLauncher: /x\n")).toBe(
			"Installed Pie 0.1.3 from abc123. Restart Pie sessions to use it.",
		);
		expect(summarizePieUpdate("Pie is already up to date at abc123.\n")).toBe("Pie is already up to date at abc123.");
		expect(summarizePieUpdate("")).toBe("Pie was updated. Restart Pie sessions to use it.");
	});
});
