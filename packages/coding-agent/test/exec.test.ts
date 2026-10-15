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
		"settles a timeout while a descendant outside the process group keeps writing",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-exec-timeout-"));
			try {
				// `detached` calls setsid, so the writer leaves the command's process group but keeps
				// writing to the inherited stdout pipe. It exits once that pipe closes, or after 20s.
				writeFileSync(
					join(directory, "writer.cjs"),
					`process.stdout.on("error", () => process.exit(0));
					setInterval(() => console.log("tick"), 20);
					setTimeout(() => process.exit(0), 20_000);`,
				);
				writeFileSync(
					join(directory, "launch.cjs"),
					`require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(directory, "writer.cjs"))}], {
						detached: true,
						stdio: ["ignore", "inherit", "inherit"],
					}).unref();`,
				);
				const started = Date.now();
				const result = await execCommand(
					"sh",
					["-c", `${JSON.stringify(process.execPath)} launch.cjs; sleep 30`],
					directory,
					{ timeout: 500 },
				);
				expect(result.killed).toBe(true);
				// Waiting for the pipes to go idle would last as long as the writer keeps writing.
				expect(Date.now() - started).toBeLessThan(5_000);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
