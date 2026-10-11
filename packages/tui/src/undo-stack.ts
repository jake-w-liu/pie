/** Generic undo stack with clone-on-push semantics. */
export class UndoStack<S> {
	private stack: S[] = [];
	private readonly clone: (state: S) => S;
	private readonly maxDepth: number;

	constructor(clone: (state: S) => S = structuredClone, maxDepth = Number.POSITIVE_INFINITY) {
		this.clone = clone;
		this.maxDepth = maxDepth;
	}

	/** Push a detached copy of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(this.clone(state));
		if (this.stack.length > this.maxDepth) this.stack.shift();
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
