import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExternalCli } from "../../pi-subagents/src/runs/shared/external-cli-runner.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external CLI post-exit drain", () => {
	it.each([false, true])(
		"settles when an owned descendant holds both pipes (chatty=%s)",
		async (chatty) => {
			const root = mkdtempSync(join(tmpdir(), "pie-external-audit-"));
			roots.push(root);
			const descendant = join(root, "descendant.cjs");
			const leader = join(root, "leader.cjs");
			// Self-expiration bounds even the red test; no unowned PID is signalled.
			writeFileSync(
				descendant,
				`setTimeout(() => process.exit(0), 12000); ${chatty ? 'setInterval(() => process.stderr.write("drain\\n"), 100);' : ""}`,
			);
			writeFileSync(
				leader,
				`const { spawn } = require("node:child_process"); const fs = require("node:fs");
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: ["ignore", 1, 2] });
fs.writeFileSync(${JSON.stringify(join(root, "pid"))}, String(child.pid));
process.stdout.write("terminal-without-newline"); process.stderr.write("diagnostic\\n");
child.unref();`,
			);
			const finish = vi.fn(() => ({ state: "completed" as const, output: "parsed result" }));
			const parseLine = vi.fn();
			let stop: (() => void) | undefined;
			const started = Date.now();
			const running = runExternalCli({
				command: process.execPath,
				args: [leader],
				cwd: root,
				prompt: "",
				asyncDir: root,
				stepIndex: 0,
				environment: { allowlist: [] },
				parser: { parseLine, finish },
				registerStop: (handler) => {
					stop = handler;
				},
			});
			try {
				const result = await running;
				expect(Date.now() - started).toBeLessThan(chatty ? 11000 : 6000);
				expect(result).toMatchObject({ exitCode: 0, output: "parsed result" });
				expect(result.error).toBeUndefined();
				expect(parseLine).toHaveBeenCalledExactlyOnceWith("terminal-without-newline");
				expect(finish).toHaveBeenCalledOnce();
				expect(readFileSync(result.externalProcess.stdoutPath!, "utf8")).toBe("terminal-without-newline");
				expect(readFileSync(result.externalProcess.stderrPath!, "utf8")).toContain("diagnostic");
				const pid = readFileSync(join(root, "pid"), "utf8");
				const status = spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" }).stdout.trim();
				expect(status === "" || status.startsWith("Z")).toBe(true);
			} finally {
				stop?.();
				await running;
			}
		},
		20000,
	);
});
