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
});
