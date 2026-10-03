import * as fs from "node:fs";

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	once(event: "error", listener: (error: unknown) => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;

interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	maxBytes?: number;
}

interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
}

export function createJsonlWriter(
	filePath: string | undefined,
	source: DrainableSource,
	deps: JsonlWriterDeps = {},
): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			async close() {},
		};
	}

	const createWriteStream = deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	const stream = ((): JsonlWriteStream | undefined => {
		try {
			return createWriteStream(filePath);
		} catch {
			return undefined;
		}
	})();
	if (!stream) {
		return {
			writeLine() {},
			async close() {},
		};
	}

	let backpressured = false;
	let closed = false;
	let failed = false;
	let bytesWritten = 0;
	let settleClose: (() => void) | undefined;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;

	// `fs.createWriteStream` reports a failed open (missing parent directory, EACCES)
	// asynchronously through `"error"`. Without a listener the event is unhandled and
	// takes the host process down, so an optional artifact could kill the session.
	// Once it fires the artifact is abandoned: writes are dropped, a source paused by
	// backpressure is resumed so the producer cannot stall, and `close()` settles.
	stream.once("error", (error: unknown) => {
		if (failed) return;
		failed = true;
		closed = true;
		if (backpressured) {
			backpressured = false;
			source.resume();
		}
		settleClose?.();
		console.error(`JSONL artifact writer for '${filePath}' failed:`, error);
	});

	return {
		writeLine(line: string) {
			if (closed || !line.trim()) return;
			const chunk = `${line}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			if (bytesWritten + chunkBytes > maxBytes) return;
			try {
				const ok = stream.write(chunk);
				bytesWritten += chunkBytes;
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						backpressured = false;
						if (!closed) source.resume();
					});
				}
			} catch {}
		},
		async close() {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve) => {
				let settled = false;
				const done = () => {
					if (settled) return;
					settled = true;
					resolve();
				};
				settleClose = done;
				stream.end(done);
			});
		},
	};
}
