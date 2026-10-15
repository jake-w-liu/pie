import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputSpool } from "./output-spool.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, isEmptyLine, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	/** Whether the open line is empty in the sense of `isEmptyLine` (nothing, or a lone CR). */
	private currentLineEmpty = true;
	private lastNonEmptyCompletedLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private spool: OutputSpool | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	append(data: Buffer): boolean {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.spool || this.shouldUseTempFile()) {
			this.ensureTempFile();
			return this.spool?.write(data) ?? true;
		}
		if (data.length > 0) this.rawChunks.push(data);
		return true;
	}

	async waitForDrain(): Promise<void> {
		await this.spool?.waitForDrain();
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.spool?.getPath(),
		};
	}

	async closeTempFile(): Promise<void> {
		await this.spool?.close();
	}

	/**
	 * Byte length of the output's last line that is not empty, the one tail truncation shows
	 * partially: the open line, or the last completed line that is not empty.
	 */
	getLastLineBytes(): number {
		return this.currentLineEmpty ? this.lastNonEmptyCompletedLineBytes : this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.extendOpenLine(text);
		} else {
			this.completedLines += newlines;
			// Walk back over the lines this text completes, newest first, to the last one that is not empty.
			for (let lineEnd = lastNewline; ; ) {
				const lineStart = lineEnd === 0 ? 0 : text.lastIndexOf("\n", lineEnd - 1) + 1;
				if (lineStart === 0) {
					// The first line this text completes continues the open line.
					this.extendOpenLine(text.slice(0, lineEnd));
					if (!this.currentLineEmpty) this.lastNonEmptyCompletedLineBytes = this.currentLineBytes;
					break;
				}
				const line = text.slice(lineStart, lineEnd);
				if (!isEmptyLine(line)) {
					this.lastNonEmptyCompletedLineBytes = byteLength(line);
					break;
				}
				lineEnd = lineStart - 1;
			}
			this.currentLineBytes = 0;
			this.currentLineEmpty = true;
			this.extendOpenLine(text.slice(lastNewline + 1));
		}
		this.hasOpenLine = this.currentLineBytes > 0;
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private extendOpenLine(text: string): void {
		if (text.length === 0) return;
		this.currentLineEmpty = this.currentLineBytes === 0 && text === "\r";
		this.currentLineBytes += byteLength(text);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		// Drop the partial first line, unless only empty lines follow it: then it is the line tail
		// truncation shows the end of, and dropping it would leave nothing but those empty lines.
		const firstNewline = this.tailText.indexOf("\n");
		const rest = this.tailText.slice(firstNewline + 1);
		if (firstNewline === -1 || rest.split("\n").every(isEmptyLine)) return this.tailText;
		return rest;
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.spool) return;
		this.spool = new OutputSpool(defaultTempFilePath(this.tempFilePrefix));
		for (const chunk of this.rawChunks) {
			this.spool.write(chunk);
		}
		this.rawChunks = [];
	}
}
