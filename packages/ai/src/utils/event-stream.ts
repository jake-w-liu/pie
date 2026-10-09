import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/** Indexed FIFO; empty reset and occasional compaction reclaim consumed storage. */
class Fifo<T> {
	private items: Array<T | undefined> = [];
	private head = 0;

	get length(): number {
		return this.items.length - this.head;
	}

	push(value: T): void {
		this.items.push(value);
	}

	shift(): T | undefined {
		if (this.head === this.items.length) return undefined;
		const value = this.items[this.head];
		this.items[this.head++] = undefined;
		if (this.head === this.items.length) {
			this.items = [];
			this.head = 0;
		} else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
			// 1024 is a local time/storage tradeoff, not an API bound. Reclaiming
			// only after half is consumed keeps copying amortized linear and the
			// unused prefix below either 1024 slots or the live backlog size.
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
		return value;
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new Fifo<T>();
	private waiting = new Fifo<(value: IteratorResult<T>) => void>();
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		const complete = this.isComplete(event);
		if (complete) {
			// A throwing extractor must leave the stream able to receive an error
			// terminal or explicit end(), rather than strand its result forever.
			const result = this.extractResult(event);
			this.done = true;
			this.resolveFinalResult(result);
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
		if (complete) this.finishWaiting();
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		this.finishWaiting();
	}

	private finishWaiting(): void {
		while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				// Presence is determined by length: undefined is a valid event.
				yield this.queue.shift() as T;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
