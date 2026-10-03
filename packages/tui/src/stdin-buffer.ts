/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";
import { decodeKittyPrintable } from "./keys.ts";

const ESC = "\x1b";
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
/** Upper bound for one bracketed paste payload. Without a cap a peer that
 * sends ESC[200~ and never terminates can grow pasteBuffer without bound (OOM).
 * Pastes beyond the cap are truncated; the overflow is discarded while still
 * scanning for the terminator so the stream resynchronizes. */
const MAX_BRACKETED_PASTE_CHARS = 1_000_000;

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	// Mirror insertion exactly: the pending value must be the code point the
	// consumer will insert (shift-preferred, functional-normalized), not the
	// raw CSI-u base code point, or a following genuine keypress gets eaten.
	const printable = decodeKittyPrintable(sequence);
	if (printable === undefined) return undefined;
	return printable.codePointAt(0);
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		if (remaining.startsWith(ESC)) {
			// Find the end of this escape sequence
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				// ESC cancels an incomplete CSI and starts a new sequence. Keeping
				// the damaged prefix would swallow later mouse releases/focus reports
				// and grow the buffer for as long as input keeps arriving.
				if (seqEnd > 1 && remaining[seqEnd - 1] === ESC && remaining.startsWith(`${ESC}[`)) {
					pos += seqEnd - 1;
					break;
				}
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					// WezTerm with enable_kitty_keyboard sends the Escape key press as a
					// raw '\x1b' byte (simple text path in encode_kitty, ignoring
					// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
					// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
					// The buffer would normally treat '\x1b\x1b' as a complete meta-key
					// sequence (ESC + single char), leaving '[27;...u' to be typed as
					// plain text. If the character immediately following '\x1b\x1b'
					// would begin a new escape sequence, emit only the first ESC and
					// restart from the second.
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" || // CSI
							nextChar === "]" || // OSC
							nextChar === "O" || // SS3
							nextChar === "P" || // DCS
							nextChar === "_" // APC
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// Not an escape sequence - take one whole character. Taking a single UTF-16
			// code unit split every astral character (emoji) into a lone high surrogate
			// followed by a lone low surrogate.
			const first = remaining.codePointAt(0)!;
			const width = first > 0xffff ? 2 : 1;
			sequences.push(remaining.slice(0, width));
			pos += width;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for an incomplete sequence such as CSI or mouse
	 * (default: 50ms).
	 */
	timeout?: number;
	/**
	 * Maximum time to wait after a lone ESC before treating it as Escape
	 * (default: 10ms). Increase for high-latency Alt+key input (SSH).
	 */
	escapeTimeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
/**
 * Decode a byte buffer as UTF-8, falling back to the legacy Meta convention
 * (`ESC` + byte - 128) for bytes that cannot start a valid sequence.
 *
 * A lead byte whose continuation bytes have not arrived yet is left pending so a
 * character split across reads is decoded once complete. A lead byte followed by a
 * byte that is *not* a continuation is legacy 8-bit input, not a broken character, so
 * it is converted immediately instead of swallowing the following character.
 */
function decodeUtf8WithLegacyFallback(buffer: Buffer): { text: string; rest: Buffer } {
	const legacyEscape = (byte: number): string => `\x1b${String.fromCharCode((byte - 128) & 0xff)}`;
	let index = 0;
	let text = "";
	while (index < buffer.length) {
		const byte = buffer[index]!;
		if (byte < 0x80) {
			text += String.fromCharCode(byte);
			index++;
			continue;
		}
		const needed =
			byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
		if (needed === 0) {
			text += legacyEscape(byte);
			index++;
			continue;
		}
		let incomplete = false;
		let valid = true;
		for (let offset = 1; offset < needed; offset++) {
			const next = buffer[index + offset];
			if (next === undefined) {
				incomplete = true;
				valid = false;
				break;
			}
			if (next < 0x80 || next > 0xbf) {
				valid = false;
				break;
			}
		}
		if (incomplete) break;
		if (!valid) {
			text += legacyEscape(byte);
			index++;
			continue;
		}
		text += buffer.subarray(index, index + needed).toString("utf8");
		index += needed;
	}
	return { text, rest: buffer.subarray(index) };
}

/** Slice to `limit` code units without cutting a surrogate pair in half. */
function sliceWithoutSplittingSurrogatePair(value: string, limit: number): string {
	if (limit <= 0 || value.length <= limit) return value.slice(0, Math.max(0, limit));
	const lastCodeUnit = value.charCodeAt(limit - 1);
	// A high surrogate at the boundary means the pair's low half was cut off.
	const boundary = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? limit - 1 : limit;
	return value.slice(0, boundary);
}

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly escapeTimeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pasteTruncated: boolean = false;
	private pasteOverflowTail: string = "";
	/** Incomplete trailing UTF-8 sequence from a Buffer chunk boundary. */
	private pendingBytes: Buffer = Buffer.alloc(0);
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
	}

	public process(data: string | Buffer): void {
		// Clear any pending timeout
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Buffer input is a byte stream, not a character stream: a multi-byte character
		// can straddle two chunks, and decoding each chunk on its own turned "€"
		// (E2 82 AC) into ESC+b plus two replacement characters. Bytes are accumulated
		// until a whole UTF-8 sequence is available. Bytes below 0xC2 can never start a
		// UTF-8 sequence, so they keep the legacy Meta conversion (ESC + byte - 128); a
		// genuine lone high byte is held until the idle timeout, where flush() applies
		// the same conversion.
		let str: string;
		if (Buffer.isBuffer(data)) {
			const pending = Buffer.concat([this.pendingBytes, data]);
			const decoded = decodeUtf8WithLegacyFallback(pending);
			this.pendingBytes = Buffer.from(decoded.rest);
			str = decoded.text;
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0 && this.pendingBytes.length === 0) {
			this.emitDataSequence("");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			if (this.pasteTruncated) {
				// Over-cap: discard content, keep only a small tail to detect the
				// terminator (which may split across chunks) so the stream
				// resynchronizes without growing memory.
				const combined = this.pasteOverflowTail + this.buffer;
				this.buffer = "";
				const endIndex = combined.indexOf(BRACKETED_PASTE_END);
				if (endIndex !== -1) {
					const pastedContent = this.pasteBuffer;
					const remaining = combined.slice(endIndex + BRACKETED_PASTE_END.length);
					this.pasteMode = false;
					this.pasteBuffer = "";
					this.pasteTruncated = false;
					this.pasteOverflowTail = "";
					this.pendingKittyPrintableCodepoint = undefined;
					this.emit("paste", pastedContent);
					this.resumeAfterPaste(remaining);
				} else {
					this.pasteOverflowTail = combined.slice(-(BRACKETED_PASTE_END.length - 1));
				}
				return;
			}
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				let pastedContent = this.pasteBuffer.slice(0, endIndex);
				if (pastedContent.length > MAX_BRACKETED_PASTE_CHARS) {
					pastedContent = sliceWithoutSplittingSurrogatePair(pastedContent, MAX_BRACKETED_PASTE_CHARS);
				}
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pasteTruncated = false;
				this.pasteOverflowTail = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);
				this.resumeAfterPaste(remaining);
			} else if (this.pasteBuffer.length > MAX_BRACKETED_PASTE_CHARS + BRACKETED_PASTE_END.length) {
				// No terminator and over budget: keep the capped prefix, discard the
				// middle, retain a small tail so a terminator split across the
				// truncation point is still detected.
				this.pasteOverflowTail = this.pasteBuffer.slice(-(BRACKETED_PASTE_END.length - 1));
				this.pasteBuffer = sliceWithoutSplittingSurrogatePair(this.pasteBuffer, MAX_BRACKETED_PASTE_CHARS);
				this.pasteTruncated = true;
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
				// A trailing incomplete sequence (a lone Escape, a mouse report split
				// across PTY reads) can no longer complete once the paste opener has
				// arrived: the opener is itself a sequence boundary. Those bytes are a
				// real keypress, so emit them now, before the paste. Queueing them and
				// replaying after the paste delivered input out of byte-stream order.
				if (result.remainder.length > 0) this.emitDataSequence(result.remainder);
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.pasteTruncated = false;
			this.pasteOverflowTail = "";
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				let pastedContent = this.pasteBuffer.slice(0, endIndex);
				if (pastedContent.length > MAX_BRACKETED_PASTE_CHARS) {
					pastedContent = sliceWithoutSplittingSurrogatePair(pastedContent, MAX_BRACKETED_PASTE_CHARS);
				}
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pasteTruncated = false;
				this.pasteOverflowTail = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);
				this.resumeAfterPaste(remaining);
			} else if (this.pasteBuffer.length > MAX_BRACKETED_PASTE_CHARS + BRACKETED_PASTE_END.length) {
				this.pasteOverflowTail = this.pasteBuffer.slice(-(BRACKETED_PASTE_END.length - 1));
				this.pasteBuffer = sliceWithoutSplittingSurrogatePair(this.pasteBuffer, MAX_BRACKETED_PASTE_CHARS);
				this.pasteTruncated = true;
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0 || this.pendingBytes.length > 0) {
			const timeoutMs = this.buffer === ESC || this.buffer.length === 0 ? this.escapeTimeoutMs : this.timeoutMs;
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emitDataSequence(sequence);
				}
			}, timeoutMs);
		}
	}

	/**
	 * Re-enter normal parsing after a bracketed paste has been emitted. Bytes
	 * queued before the paste start are prepended so a sequence split across
	 * the paste boundary is re-assembled instead of being dropped.
	 */
	private resumeAfterPaste(remaining: string): void {
		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		const sequences: string[] = [];
		if (this.pendingBytes.length > 0) {
			// The held bytes never completed a UTF-8 sequence, so treat them as legacy
			// 8-bit Meta input exactly as a single-byte chunk used to be treated.
			sequences.push(
				this.pendingBytes
					.toString("latin1")
					.replace(/[\u0080-\u00ff]/g, (char) => `\x1b${String.fromCharCode((char.charCodeAt(0) - 128) & 0xff)}`),
			);
			this.pendingBytes = Buffer.alloc(0);
		}
		if (this.buffer.length === 0) {
			return sequences;
		}

		sequences.push(this.buffer);
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pasteTruncated = false;
		this.pasteOverflowTail = "";
		this.pendingBytes = Buffer.alloc(0);
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
