/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { OutputSpool } from "./tools/output-spool.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let spool: OutputSpool | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (spool) return;
		const id = randomBytes(8).toString("hex");
		spool = new OutputSpool(join(tmpdir(), `pi-bash-${id}.log`));
		for (const chunk of outputChunks) {
			spool.write(chunk);
		}
	};

	const decoder = new TextDecoder();
	let acceptingOutput = true;

	const onData = (data: Buffer) => {
		if (!acceptingOutput) return;
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		spool?.write(text);

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	let exitCode: number | null;
	try {
		const result = await operations.exec(command, cwd, { onData, signal: options?.signal });
		acceptingOutput = false;
		exitCode = result.exitCode;
	} catch (err) {
		acceptingOutput = false;
		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (options?.signal?.aborted && truncationResult.truncated) ensureTempFile();
		try {
			await spool?.close();
		} catch (spoolError) {
			throw new AggregateError([err, spoolError], "Command execution and output persistence failed", { cause: err });
		}
		if (!options?.signal?.aborted) throw err;
		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: undefined,
			cancelled: true,
			truncated: truncationResult.truncated,
			fullOutputPath: spool?.getPath(),
		};
	}

	const fullOutput = outputChunks.join("");
	const truncationResult = truncateTail(fullOutput);
	if (truncationResult.truncated) ensureTempFile();
	// Artifact failure is not cancellation success, even if cancellation raced
	// successful command completion. Close outside the command-error boundary.
	await spool?.close();
	const cancelled = options?.signal?.aborted ?? false;
	return {
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: truncationResult.truncated,
		fullOutputPath: spool?.getPath(),
	};
}
