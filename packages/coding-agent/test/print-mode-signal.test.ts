import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/print-mode-signal.ts", import.meta.url));

/**
 * JSON mode emits one JSON object per event before the fixture's own summary line,
 * so the summary is the last line of stdout.
 */
function parseSummary(stdout: string): unknown {
	const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
	return JSON.parse(lines.at(-1) ?? "");
}

test.each([
	["SIGHUP", 129],
	["SIGINT", 130],
	["SIGTERM", 143],
] as const)("flushes JSON stdout before exiting for %s", async (signal, expectedCode) => {
	const { stdout } = await execFileAsync(process.execPath, [fixture], {
		env: { ...process.env, TEST_SIGNAL: signal },
		timeout: 10_000,
	});
	expect(parseSummary(stdout)).toEqual({
		disposeAttempted: true,
		disposeSettled: true,
		exitCode: expectedCode,
		exitBeforeDisposeSettled: false,
		exitBeforeWriteCompleted: false,
		unhandledRejections: 0,
		writeCompleted: true,
	});
});

test("keeps the signal handler installed while runtime disposal and stdout flushing finish", async () => {
	const { stdout } = await execFileAsync(process.execPath, [fixture], {
		env: { ...process.env, TEST_SIGNAL: "SIGINT", TEST_SIGNAL_DURING_DISPOSE: "1" },
		timeout: 10_000,
	});
	expect(parseSummary(stdout)).toEqual({
		disposeAttempted: true,
		disposeSettled: true,
		exitCode: 130,
		exitBeforeDisposeSettled: false,
		exitBeforeWriteCompleted: false,
		unhandledRejections: 0,
		writeCompleted: true,
	});
});

test("flushes stdout and exits with the signal code when runtime disposal rejects", async () => {
	const { stderr, stdout } = await execFileAsync(process.execPath, [fixture], {
		env: { ...process.env, TEST_DISPOSE_REJECTS: "1", TEST_SIGNAL: "SIGINT" },
		timeout: 10_000,
	});
	expect(parseSummary(stdout)).toEqual({
		disposeAttempted: true,
		disposeSettled: true,
		exitCode: 130,
		exitBeforeDisposeSettled: false,
		exitBeforeWriteCompleted: false,
		unhandledRejections: 0,
		writeCompleted: true,
	});
	expect(stderr).toContain("Failed to dispose runtime during SIGINT: dispose failed");
});

test("keeps the signal exit path when disposal rejects after the signal arrives", async () => {
	const { stderr, stdout } = await execFileAsync(process.execPath, [fixture], {
		env: {
			...process.env,
			TEST_DISPOSE_REJECTS: "1",
			TEST_SIGNAL: "SIGINT",
			TEST_SIGNAL_DURING_DISPOSE: "1",
		},
		timeout: 10_000,
	});
	expect(parseSummary(stdout)).toEqual({
		disposeAttempted: true,
		disposeSettled: true,
		exitCode: 130,
		exitBeforeDisposeSettled: false,
		exitBeforeWriteCompleted: false,
		unhandledRejections: 0,
		writeCompleted: true,
	});
	expect(stderr).toContain("Failed to dispose runtime during SIGINT: dispose failed");
});

test("exits with the real signal status and flushed stdout when disposal rejects", async () => {
	// No process.exit stub here: the child really terminates, so this covers the OS exit
	// status and the flush ordering that a stubbed exit cannot show.
	const failure = await execFileAsync(process.execPath, [fixture], {
		env: {
			...process.env,
			TEST_DISPOSE_REJECTS: "1",
			TEST_REAL_EXIT: "1",
			TEST_SIGNAL: "SIGINT",
			TEST_SIGNAL_DURING_DISPOSE: "1",
		},
		timeout: 10_000,
	}).then(
		() => undefined,
		(error: { code?: number | string; stdout?: string; stderr?: string }) => error,
	);
	expect(failure).toBeDefined();
	expect(failure?.code).toBe(130);
	// The context_limit event queued during prompt() must have reached real stdout.
	expect(failure?.stdout ?? "").toContain("context_limit");
	expect(failure?.stderr ?? "").toContain("Failed to dispose runtime during SIGINT: dispose failed");
});

test("exits on a repeated signal while shutdown waits for work that ignores abort", async () => {
	const failure = await execFileAsync(process.execPath, [fixture], {
		env: { ...process.env, TEST_DISPOSE_HANGS: "1", TEST_REAL_EXIT: "1", TEST_SIGNAL: "SIGINT" },
		// The child handles SIGTERM itself, so a hung child must be killed outright.
		killSignal: "SIGKILL",
		timeout: 30_000,
	}).then(
		() => undefined,
		(error: { code?: number | string; killed?: boolean }) => error,
	);
	expect(failure?.killed).toBe(false);
	expect(failure?.code).toBe(130);
}, 40_000);
