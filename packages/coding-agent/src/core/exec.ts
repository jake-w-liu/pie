/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const useProcessGroup = process.platform !== "win32";
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: useProcessGroup,
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;
		// After a cancelled command has exited (or been force-killed), stop reading after a fixed
		// pipe deadline: a descendant that left the process group can keep writing to the inherited
		// pipe forever. Not earlier, so a command that handles SIGTERM keeps its grace period.
		const cancellation = new AbortController();
		const stopWaitingForPipes = () => cancellation.abort();

		const sendSignal = (signal: NodeJS.Signals) => {
			if (useProcessGroup && proc.pid !== undefined) {
				try {
					process.kill(-proc.pid, signal);
					return;
				} catch {
					// Fall back to the direct child if its process group is already gone.
				}
			}
			proc.kill(signal);
		};

		const killProcess = () => {
			if (proc.exitCode !== null || proc.signalCode !== null) {
				// The command exited but descendants still hold its pipes. Those in the command's own
				// process group are still ours to stop; ones that left the group are only abandoned.
				if (!killed) {
					killed = true;
					if (useProcessGroup) sendSignal("SIGKILL");
				}
				stopWaitingForPipes();
				return;
			}
			if (!killed) {
				killed = true;
				proc.once("exit", stopWaitingForPipes);
				sendSignal("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				forceKillId = setTimeout(() => {
					// `killed` means a signal was sent, not that the child exited.
					if (proc.exitCode === null && proc.signalCode === null) {
						sendSignal("SIGKILL");
					}
					stopWaitingForPipes();
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (data: string) => {
			stdout += data;
		});

		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (data: string) => {
			stderr += data;
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc, cancellation.signal)
			.then((code) => {
				// The group leader can exit after TERM while a descendant ignores it.
				// Finish cleaning up the owned process group before reporting completion.
				if (killed && useProcessGroup) sendSignal("SIGKILL");
				if (timeoutId) clearTimeout(timeoutId);
				if (forceKillId) clearTimeout(forceKillId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 1, killed });
			})
			.catch((_err) => {
				if (killed && useProcessGroup) sendSignal("SIGKILL");
				if (timeoutId) clearTimeout(timeoutId);
				if (forceKillId) clearTimeout(forceKillId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
