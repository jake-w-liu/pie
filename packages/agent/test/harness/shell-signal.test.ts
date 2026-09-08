import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createBashTool } from "../../src/harness/tools/bash.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { executeShellWithCapture } from "../../src/harness/utils/shell-output.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("shell signal termination", () => {
	it.each(["SIGTERM", "SIGKILL"] as const)(
		"reports %s as a nonzero exit through exec, capture and bash",
		async (signal) => {
			const env = new NodeExecutionEnv({ cwd: createTempDir() });
			// $$ is the shell spawned for this invocation, never an unrelated process.
			const command = `printf before; kill -${signal.slice(3)} $$`;
			const exitCode = 128 + constants.signals[signal];
			try {
				expect(getOrThrow(await env.exec(command))).toEqual({ stdout: "before", stderr: "", exitCode });
				const capture = getOrThrow(await executeShellWithCapture(env, command));
				expect(capture).toMatchObject({ output: "before", exitCode, cancelled: false });
				expect(capture.executionError).toBeUndefined();
				await expect(
					createBashTool().execute("signal", { command }, undefined, undefined, { env }),
				).rejects.toThrow(`before\n\nCommand exited with code ${exitCode}`);
			} finally {
				await env.cleanup();
			}
		},
	);

	it("retains normal exit codes and separate cancellation/timeout outcomes", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		try {
			expect(getOrThrow(await env.exec("exit 0")).exitCode).toBe(0);
			expect(getOrThrow(await env.exec("exit 7")).exitCode).toBe(7);
			const controller = new AbortController();
			expect(
				await env.exec("printf ready; sleep 60", {
					abortSignal: controller.signal,
					onStdout: () => controller.abort(),
				}),
			).toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(await env.exec("sleep 60", { timeout: 0.01 })).toMatchObject({ ok: false, error: { code: "timeout" } });
		} finally {
			await env.cleanup();
		}
	});
});
