import type { Readable } from "node:stream";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 *
 * The source stream defaults to `process.stdin` but can be injected for tests.
 */
export async function readPipedStdin(source: Readable = process.stdin): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if ((source as NodeJS.ReadStream).isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		const onData = (chunk: string) => {
			data += chunk;
		};
		// Listeners are removed once stdin settles so later stdin consumers
		// (the TUI, RPC framing) never see a stale `data` listener or encoding.
		const cleanup = () => {
			source.off("data", onData);
			source.off("end", onEnd);
			source.off("error", onError);
		};
		const onEnd = () => {
			cleanup();
			source.pause();
			// Only whitespace-only input counts as empty. Trimming a real prompt stripped
			// leading indentation and trailing newlines from piped code blocks.
			resolve(data.trim().length === 0 ? undefined : data);
		};
		const onError = () => {
			cleanup();
			source.pause();
			resolve(undefined);
		};
		source.setEncoding("utf8");
		source.on("data", onData);
		source.on("end", onEnd);
		source.on("error", onError);
		source.resume();
	});
}
