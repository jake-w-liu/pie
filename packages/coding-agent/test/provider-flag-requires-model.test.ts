import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-provider-flag-")));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, stderr };
}

describe("--provider requires --model", () => {
	it("errors instead of silently running the settings/default model", async () => {
		// `--provider` only disambiguates a model id across providers, so without
		// `--model` it was ignored and the run used whatever model was configured.
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		const result = await runCli(["--provider", "openai", "-p", "hi"], projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--provider requires --model");
	});
});
