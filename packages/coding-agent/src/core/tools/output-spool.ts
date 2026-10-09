import { createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** Own a spill stream from creation through completion, including early errors. */
export class OutputSpool {
	private readonly filePath: string;
	private stream: WriteStream | undefined;
	private readonly completion: Promise<void>;
	private failure: { error: unknown } | undefined;
	private closing = false;
	private readonly onError = (error: Error): void => {
		this.failure ??= { error };
	};

	constructor(filePath: string) {
		this.filePath = filePath;
		try {
			const stream = createWriteStream(filePath);
			this.stream = stream;
			stream.on("error", this.onError);
			// Observe immediately, not only after the producer has stopped. The
			// rejection is retained for close(), never left as an unhandled promise.
			this.completion = finished(stream, { cleanup: true }).catch((error: unknown) => {
				this.failure ??= { error };
			});
		} catch (error) {
			this.failure = { error };
			this.completion = Promise.resolve();
		}
	}

	write(data: string | Buffer): void {
		if (!this.stream || this.failure || this.closing) return;
		try {
			this.stream.write(data);
		} catch (error) {
			this.failure ??= { error };
			this.stream.destroy();
		}
	}

	getPath(): string | undefined {
		return this.failure ? undefined : this.filePath;
	}

	async close(): Promise<void> {
		if (!this.closing) {
			this.closing = true;
			try {
				this.stream?.end();
			} catch (error) {
				this.failure ??= { error };
				this.stream?.destroy();
			}
		}
		await this.completion;
		this.stream?.off("error", this.onError);
		if (this.failure) throw this.failure.error;
	}
}
