import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	it("decodes UTF-8 continuously across output chunks", async () => {
		const script = [
			"const chunks = [[0xe2], [0x82], [0xac]];",
			"let index = 0;",
			"const write = () => {",
			"  if (index === chunks.length) return;",
			"  process.stdout.write(Buffer.from(chunks[index++]));",
			"  setTimeout(write, 10);",
			"};",
			"write();",
		].join("\n");

		const result = await execCommand(process.execPath, ["-e", script], process.cwd());

		expect(result).toMatchObject({ code: 0, stdout: "€", stderr: "" });
	});

	it.skipIf(process.platform === "win32")("terminates descendants on timeout", async () => {
		const result = await execCommand("sh", ["-c", "sleep 30 & echo $!; wait"], process.cwd(), { timeout: 100 });
		const descendantPid = Number(result.stdout.trim());

		expect(result.killed).toBe(true);
		expect(descendantPid).toBeGreaterThan(0);
		expect(() => process.kill(descendantPid, 0)).toThrow();
	});

	it.skipIf(process.platform === "win32")(
		"kills its own process group when the timeout fires after the command exited",
		async () => {
			// The background loop stays in the command's process group and ignores SIGPIPE.
			const result = await execCommand(
				"sh",
				["-c", "(trap '' PIPE; while :; do echo tick; sleep 0.05; done) & echo pid=$!; exit 0"],
				process.cwd(),
				{ timeout: 500 },
			);
			const loopPid = Number(/pid=(\d+)/.exec(result.stdout)?.[1]);
			expect(loopPid).toBeGreaterThan(0);
			expect(result.killed).toBe(true);
			// SIGKILL is sent before the call settles; allow the orphan's reaper a moment.
			const deadline = Date.now() + 3_000;
			const alive = () => {
				try {
					process.kill(loopPid, 0);
					return true;
				} catch {
					return false;
				}
			};
			while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
			expect(alive()).toBe(false);
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"settles a timeout while a descendant outside the process group keeps writing",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-exec-timeout-"));
			try {
				// `detached` calls setsid, so the writer leaves the command's process group but keeps
				// writing to the inherited stdout pipe. It exits once that pipe closes, or after 60s.
				// The launcher exits only after the writer's first line is flushed into the pipe.
				const ready = join(directory, "ready");
				writeFileSync(
					join(directory, "writer.cjs"),
					`const fs = require("node:fs");
					process.stdout.on("error", () => process.exit(0));
					process.stdout.write("tick\\n", () => fs.writeFileSync(${JSON.stringify(ready)}, ""));
					setInterval(() => console.log("tick"), 20);
					setTimeout(() => process.exit(0), 60_000);`,
				);
				writeFileSync(
					join(directory, "launch.cjs"),
					`const fs = require("node:fs");
					fs.rmSync(${JSON.stringify(ready)}, { force: true });
					require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(directory, "writer.cjs"))}], {
						detached: true,
						stdio: ["ignore", "inherit", "inherit"],
					}).unref();
					const deadline = Date.now() + 10_000;
					const wait = () => (fs.existsSync(${JSON.stringify(ready)}) || Date.now() > deadline ? undefined : setTimeout(wait, 10));
					wait();`,
				);
				// Timeout while the command runs: the shell is killed, the writer escaped the group.
				let started = Date.now();
				const killed = await execCommand(
					"sh",
					["-c", `${JSON.stringify(process.execPath)} launch.cjs; sleep 30`],
					directory,
					{ timeout: 500 },
				);
				expect(killed.killed).toBe(true);
				// Waiting for the pipes to go idle would last as long as the writer keeps writing.
				expect(Date.now() - started).toBeLessThan(5_000);

				// Timeout after the command already exited: only the writer's pipe keeps the call open.
				// The timeout leaves the launcher ample time to start its writer and exit, even on a
				// loaded machine; waiting for the pipes instead would last the writer's full 60s.
				started = Date.now();
				const exited = await execCommand(process.execPath, ["launch.cjs"], directory, { timeout: 8_000 });
				expect(exited.code).toBe(0);
				expect(exited.stdout).toContain("tick");
				expect(Date.now() - started).toBeLessThan(30_000);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
		90_000,
	);
});
