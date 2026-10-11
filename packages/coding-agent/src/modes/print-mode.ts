/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	setFatalStdoutCleanup,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	// On a fatal stdout write (client closed the pipe), release tracked children
	// and the runtime instead of exiting and orphaning them.
	setFatalStdoutCleanup(() => {
		killTrackedDetachedChildren();
		return runtimeHost.dispose();
	});

	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposePromise: Promise<void> | undefined;
	let signalShutdown: Promise<void> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = (): Promise<void> => {
		if (!disposePromise) {
			unsubscribe?.();
			unsubscribeBackpressure?.();
			disposePromise = Promise.resolve().then(() => runtimeHost.dispose());
		}
		return disposePromise;
	};

	/**
	 * Finish the runtime once, whatever order shutdown and disposal complete in. A signal
	 * that arrives while disposal is already running owns the exit code and flushes stdout
	 * itself, so a disposal rejection must not preempt it; without a signal the failure is
	 * reported to the caller. Signal handlers stay installed until the flush is done.
	 */
	const finalizeRuntime = async (): Promise<void> => {
		try {
			if (signalShutdown) {
				await signalShutdown;
				return;
			}
			try {
				await disposeRuntime();
			} catch (error: unknown) {
				if (!signalShutdown) throw error;
				await signalShutdown;
				return;
			}
			await flushRawStdout();
		} finally {
			for (const cleanup of signalCleanupHandlers) {
				cleanup();
			}
		}
	};

	const registerSignalHandlers = (): void => {
		// SIGINT (Ctrl-C) must clean up like SIGTERM; otherwise detached bash
		// children survive and the runtime is never disposed.
		const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				if (signalShutdown) return;
				signalShutdown = (async () => {
					killTrackedDetachedChildren();
					try {
						await disposeRuntime();
					} catch (error: unknown) {
						console.error(
							`Failed to dispose runtime during ${signal}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					await flushRawStdout();
					process.exit(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143);
				})();
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "context_limit") {
				exitCode = 1;
				if (mode === "text")
					console.error(
						`Stopped at the context limit (${event.tokens}/${event.contextWindow} tokens). Compact the session or use a larger-context model.`,
					);
			}
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];
		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				if (mode === "text") console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				exitCode = 1;
			} else if (mode === "text") {
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						writeRawStdout(`${content.text}\n`);
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		await finalizeRuntime();
	}
}
