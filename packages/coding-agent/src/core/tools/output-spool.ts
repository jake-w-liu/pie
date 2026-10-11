import { createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** Own a spill stream from creation through completion, including early errors. */
export class OutputSpool {
	private readonly filePath: string;
	private stream: WriteStream | undefined;
	private readonly completion: Promise<void>;
	private failure: { error: unknown } | undefined;
	private closing = false;
	private drainPromise: Promise<void> | undefined;
	private resolveDrain: (() => void) | undefined;
	private readonly onError = (error: Error): void => {
		this.failure ??= { error };
		this.resolveDrain?.();
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

	write(data: string | Buffer): boolean {
		if (!this.stream || this.failure || this.closing) return true;
		try {
			const canContinue = this.stream.write(data);
			if (!canContinue && !this.drainPromise) {
				this.drainPromise = new Promise<void>((resolve) => {
					this.resolveDrain = () => {
						this.drainPromise = undefined;
						this.resolveDrain = undefined;
						resolve();
					};
					this.stream?.once("drain", this.resolveDrain);
				});
			}
			return canContinue;
		} catch (error) {
			this.failure ??= { error };
			this.stream.destroy();
			return true;
		}
	}

	async waitForDrain(): Promise<void> {
		await this.drainPromise;
	}

	getPath(): string | undefined {
		return this.failure ? undefined : this.filePath;
	}

	async close(): Promise<void> {
		if (!this.closing) {
			this.closing = true;
			// Ending the stream settles a pending backpressure wait: `drain` may never fire once the
			// stream ends, so a consumer waiting on it would stay paused forever.
			this.resolveDrain?.();
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
