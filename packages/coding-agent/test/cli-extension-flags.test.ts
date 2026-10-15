import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface CliResult {
	code: number | null;
	stderr: string;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<CliResult> {
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd,
		env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise((resolvePromise, reject) => {
		// Cold-start module loading alone can take over 10s on a loaded machine.
		const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stderr });
		});
	});
}

describe("extension CLI flags", () => {
	it("keeps the prompt that follows a boolean extension flag", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cli-extension-flags-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		// A configured model is required to reach print mode; the input handler below answers
		// the prompt itself, so no request is made.
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					mock: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "mock-key",
						models: [{ id: "mock-model", contextWindow: 100000, maxTokens: 1000 }],
					},
				},
			}),
		);
		const extensionPath = join(root, "plan-flag.mjs");
		writeFileSync(
			extensionPath,
			`export default function (pi) {
	pi.registerFlag("plan", { description: "Start in plan mode", type: "boolean", default: false });
	pi.on("input", (event) => {
		process.stderr.write("plan=" + pi.getFlag("plan") + " input=" + event.text + "\\n");
		return { action: "handled" };
	});
}
`,
		);

		const result = await runCli(
			[
				"-e",
				extensionPath,
				"--no-session",
				"--provider",
				"mock",
				"--model",
				"mock-model",
				"-p",
				"--plan",
				"Refactor the auth module",
			],
			projectDir,
			agentDir,
		);

		expect(result.stderr).toContain("plan=true input=Refactor the auth module");
		expect(result.code).toBe(0);
	}, 60_000);
});
