/**
 * Entries kept for yank-pop (GNU Readline's default). Kills store their full
 * text, including expanded pastes of up to 1M characters, so an unbounded ring
 * would retain every kill of a long session.
 */
const MAX_KILL_RING_ENTRIES = 10;

/**
 * Ring buffer for Emacs-style kill/yank operations.
 *
 * Tracks killed (deleted) text entries. Consecutive kills can accumulate
 * into a single entry. Supports yank (paste most recent) and yank-pop
 * (cycle through older entries).
 */
export class KillRing {
	/** Entries in kill order, newest last, so the cap always evicts the oldest kill. */
	private ring: string[] = [];
	/** How many entries yank-pop has stepped back from the newest; a new kill resets it. */
	private yankOffset = 0;

	/**
	 * Add text to the kill ring.
	 *
	 * @param text - The killed text to add
	 * @param opts - Push options
	 * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
	 * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.ring.push(text);
			if (this.ring.length > MAX_KILL_RING_ENTRIES) {
				this.ring.shift();
			}
		}
		this.yankOffset = 0;
	}

	/** Get the entry to yank (the most recent kill until yank-pop) without modifying the ring. */
	peek(): string | undefined {
		return this.ring[this.ring.length - 1 - this.yankOffset];
	}

	/** Remove all retained killed text. */
	clear(): void {
		this.ring.length = 0;
		this.yankOffset = 0;
	}

	/**
	 * Step the entry to yank to the next older one, wrapping from the oldest back to the
	 * newest (for yank-pop cycling). Entries keep their kill order, as in GNU Readline.
	 */
	rotate(): void {
		if (this.ring.length > 1) {
			this.yankOffset = (this.yankOffset + 1) % this.ring.length;
		}
	}

	get length(): number {
		return this.ring.length;
	}
}
