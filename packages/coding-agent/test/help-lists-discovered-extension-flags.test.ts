import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-help-flags-")));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stdout: string }> {
	let stdout = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "ignore"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, stdout };
}

describe("help lists extension flags", () => {
	it("includes flags registered by a discovered extension", async () => {
		// The fast help path skipped resource loading whenever no `-e` flag was passed,
		// so an extension auto-discovered from the agent dir (or an installed package)
		// never contributed its CLI flags to `--help`.
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "flag-ext.ts"),
			'export default function (pi) { pi.registerFlag("myflag", { description: "A test flag", type: "boolean" }); }\n',
		);

		const result = await runCli(["--help"], projectDir, agentDir);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--myflag");
		expect(result.stdout).toContain("Extension CLI Flags:");
	});
});
