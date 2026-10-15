import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
});

/** Print mode over a real faux-backed session, with stdout and stderr captured. */
async function createPrintRuntime(options: HarnessOptions) {
	harness = await createHarness(options);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Unexpected session replacement in print mode test");
		},
	);
	const stdout: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string, callback?: () => void) => {
		stdout.push(String(chunk));
		callback?.();
		return true;
	}) as typeof process.stdout.write);
	const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
	return { harness, runtime, stdout, stderr };
}

describe("runPrintMode with a real session", () => {
	it("waits for a turn that an extension command starts without awaiting it", async () => {
		const { harness, runtime, stdout } = await createPrintRuntime({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("ask", {
						description: "Ask the model",
						handler: async (args) => {
							pi.sendUserMessage(args);
						},
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("4")]);

		const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "/ask what is 2+2" });

		expect(exitCode).toBe(0);
		expect(stdout.join("")).toBe("4\n");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("stops at a failed earlier prompt and reports it", async () => {
		const { harness, runtime, stdout, stderr } = await createPrintRuntime({
			settings: { retry: { enabled: false } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "first prompt failed" }),
			fauxAssistantMessage("second ok"),
		]);

		const exitCode = await runPrintMode(runtime, {
			mode: "text",
			initialMessage: "first task",
			messages: ["second task"],
		});

		expect(exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("first prompt failed");
		expect(stdout.join("")).toBe("");
		// The second prompt was not sent on top of the failed turn.
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
