import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";

/** Adapted from the Apache-2.0 Headroom implementation in ds-build. */
export const HEADROOM_RETRIEVE_TOOL_NAME = "headroom_retrieve";

const ENV_PREFIX = APP_NAME.toUpperCase();
export const ENV_HEADROOM = `${ENV_PREFIX}_HEADROOM`;
export const ENV_HEADROOM_MIN_CHARS = `${ENV_PREFIX}_HEADROOM_MIN_CHARS`;
export const ENV_HEADROOM_MAX_SEGMENTS = `${ENV_PREFIX}_HEADROOM_MAX_SEGMENTS`;
export const ENV_HEADROOM_KEEP_LINES = `${ENV_PREFIX}_HEADROOM_KEEP_LINES`;
export const ENV_HEADROOM_MAX_STORE_ENTRIES = `${ENV_PREFIX}_HEADROOM_MAX_STORE_ENTRIES`;
export const ENV_HEADROOM_MAX_STORE_CHARS = `${ENV_PREFIX}_HEADROOM_MAX_STORE_CHARS`;

const DEFAULT_MIN_CHARS = 2_000;
const DEFAULT_MAX_SEGMENTS = 12;
const DEFAULT_KEEP_LINES = 40;
const DEFAULT_MAX_STORE_ENTRIES = 256;
const DEFAULT_MAX_STORE_CHARS = 16 * 1024 * 1024;
const MAX_MIN_CHARS = 1_000_000;
const MAX_SEGMENTS = 10_000;
const MAX_KEEP_LINES = 1_000;
const MAX_STORE_ENTRIES = 4_096;
const MAX_STORE_CHARS = 128 * 1024 * 1024;
const MAX_RETRIEVE_CHARS = 1_000_000;
const MAX_RETRIEVE_MATCHES = 10_000;
const MAX_RETRIEVE_CONTEXT_LINES = 1_000;
const DEFAULT_RETRIEVE_MAX_CHARS = 12_000;
const DEFAULT_RETRIEVE_MAX_MATCHES = 50;
const DEFAULT_RETRIEVE_CONTEXT_LINES = 0;
const DEFAULT_JSON_ITEMS = 8;
const MAX_JSON_KEYS = 24;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_PREVIEW_INPUT = 1024 * 1024;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_BUFFERED_UTF8_SLICE_BYTES = 256 * 1024;
const FALSY_FLAGS = new Set(["0", "false", "no", "off", "disable", "disabled"]);
const SKIPPED_TOOL_NAMES = new Set([
	HEADROOM_RETRIEVE_TOOL_NAME,
	"spawn_subagent",
	"get_command_or_subagent_output",
	"get_task_output",
	"kill_command_or_subagent",
	"kill_task",
	"monitor",
	"task",
	"todowrite",
	"todo_write",
	"update_goal",
	"subagent",
	"subagent_wait",
	"subagent_supervisor",
]);

interface CachedCompression {
	hash: string;
	keepLines: number;
	marker: string;
	originalBytes: number;
	markerBytes: number;
}

interface LineRange {
	start: number;
	end: number;
}

export interface HeadroomCompressionStats {
	attemptedSegments: number;
	compressedSegments: number;
	failedSegments: number;
	tokensBefore: number;
	tokensAfter: number;
	tokensSaved: number;
}

export interface HeadroomSessionStats extends HeadroomCompressionStats {
	lastError?: string;
}

export interface HeadroomStoredContent {
	hash: string;
	content: string;
	originalChars: number;
	compressedChars: number;
	toolCallId?: string;
}

export interface HeadroomRetrieveOptions {
	query?: string;
	maxChars?: number;
	maxMatches?: number;
	contextLines?: number;
}

export type HeadroomRetrieveResult =
	| { ok: true; content: string }
	| { ok: false; reason: "invalid_hash" | "not_found" };

export interface HeadroomControllerOptions {
	env?: NodeJS.ProcessEnv;
	defaultEnabled?: boolean;
	minChars?: number;
	maxSegments?: number;
	keepLines?: number;
	maxStoreEntries?: number;
	maxStoreChars?: number;
}

function emptySessionStats(): HeadroomSessionStats {
	return {
		attemptedSegments: 0,
		compressedSegments: 0,
		failedSegments: 0,
		tokensBefore: 0,
		tokensAfter: 0,
		tokensSaved: 0,
	};
}

function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function estimateTokensFromBytes(bytes: number): number {
	return Math.ceil(bytes / 4);
}

function codePointLength(text: string): number {
	let length = 0;
	for (const _character of text) length += 1;
	return length;
}

function codeUnitIndexAfterCodePoints(text: string, maxCodePoints: number): number {
	let index = 0;
	let count = 0;
	while (index < text.length && count < maxCodePoints) {
		const codePoint = text.codePointAt(index)!;
		index += codePoint > 0xffff ? 2 : 1;
		count += 1;
	}
	return index;
}

function takeCodePointPrefix(text: string, max: number): string {
	return text.slice(0, codeUnitIndexAfterCodePoints(text, max));
}

function takeCodePointSuffix(text: string, max: number): string {
	let index = text.length;
	let count = 0;
	while (index > 0 && count < max) {
		index -= 1;
		const codeUnit = text.charCodeAt(index);
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && index > 0) {
			const preceding = text.charCodeAt(index - 1);
			if (preceding >= 0xd800 && preceding <= 0xdbff) index -= 1;
		}
		count += 1;
	}
	return text.slice(index);
}

function truncateCodePoints(text: string, max: number): string {
	const end = codeUnitIndexAfterCodePoints(text, max);
	return end === text.length ? text : `${text.slice(0, end)}…`;
}

function utf8CodePointWidth(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
	let bytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index)!;
		const width = utf8CodePointWidth(codePoint);
		if (bytes + width > maxBytes) break;
		bytes += width;
		index += codePoint > 0xffff ? 2 : 1;
	}
	return index === text.length ? text : text.slice(0, index);
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
	let bytes = 0;
	let index = text.length;
	while (index > 0) {
		let start = index - 1;
		const codeUnit = text.charCodeAt(start);
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
			const preceding = text.charCodeAt(start - 1);
			if (preceding >= 0xd800 && preceding <= 0xdbff) start -= 1;
		}
		const width = utf8CodePointWidth(text.codePointAt(start)!);
		if (bytes + width > maxBytes) break;
		bytes += width;
		index = start;
	}
	return index === 0 ? text : text.slice(index);
}

function takeUtf8Edges(
	text: string,
	originalBytes: number,
	headBytes: number,
	tailBytes: number,
): { head: string; tail: string } {
	if (originalBytes > MAX_BUFFERED_UTF8_SLICE_BYTES) {
		return {
			head: takeUtf8Prefix(text, headBytes),
			tail: takeUtf8Suffix(text, tailBytes),
		};
	}
	const buffer = Buffer.from(text, "utf8");
	let headEnd = Math.max(0, Math.min(headBytes, buffer.length));
	while (headEnd > 0 && headEnd < buffer.length && (buffer[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
	let tailStart = Math.max(0, buffer.length - Math.max(0, tailBytes));
	while (tailStart < buffer.length && (buffer[tailStart]! & 0xc0) === 0x80) tailStart += 1;
	return {
		head: buffer.subarray(0, headEnd).toString("utf8"),
		tail: buffer.subarray(tailStart).toString("utf8"),
	};
}

function normalizeHash(hash: string): string | undefined {
	const normalized = hash.trim().toLowerCase().replace(/^0x/, "");
	return /^[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, cap: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, cap) : fallback;
}

function validatePositiveOption(name: string, value: number | undefined, cap: number): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > cap)) {
		throw new RangeError(`${name} must be a positive safe integer no greater than ${cap}`);
	}
}

function boundedPositiveOption(value: number | undefined, fallback: number, cap: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, cap) : fallback;
}

function boundedNonNegativeOption(value: number | undefined, fallback: number, cap: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : fallback;
}

function isFalsyFlag(value: string): boolean {
	return FALSY_FLAGS.has(value.trim().toLowerCase());
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function summarizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return `[array:${value.length}]`;
	if (value !== null && typeof value === "object") return `{object:${Object.keys(value).length}}`;
	if (typeof value === "string") {
		const end = codeUnitIndexAfterCodePoints(value, 200);
		if (end < value.length) return `${value.slice(0, end)}...`;
	}
	return value;
}

function previewJson(value: unknown, depth = 0): unknown {
	if (depth >= MAX_JSON_DEPTH) return summarizeValue(value);
	if (Array.isArray(value)) {
		const preview = value.slice(0, DEFAULT_JSON_ITEMS).map((item) => previewJson(item, depth + 1));
		if (value.length > DEFAULT_JSON_ITEMS) {
			preview.push({
				__headroom_omitted_items: value.length - DEFAULT_JSON_ITEMS,
				__headroom_total_items: value.length,
			});
		}
		return preview;
	}
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value);
		const record = value as Record<string, unknown>;
		const preview = Object.create(null) as Record<string, unknown>;
		for (let index = 0; index < Math.min(keys.length, MAX_JSON_KEYS); index += 1) {
			const key = keys[index]!;
			preview[key] = previewJson(record[key], depth + 1);
		}
		if (keys.length > MAX_JSON_KEYS) preview.__headroom_omitted_keys = keys.slice(MAX_JSON_KEYS);
		return preview;
	}
	return summarizeValue(value);
}

function summarizeJson(text: string, originalBytes: number): string | undefined {
	if (originalBytes > MAX_JSON_PREVIEW_INPUT) return undefined;
	let firstContentIndex = 0;
	while (firstContentIndex < text.length) {
		const code = text.charCodeAt(firstContentIndex);
		if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
		firstContentIndex += 1;
	}
	const firstCharacter = text[firstContentIndex];
	if (firstCharacter !== "{" && firstCharacter !== "[") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
	const previewText = truncateCodePoints(JSON.stringify(previewJson(parsed), undefined, 2), MAX_SUMMARY_CHARS);
	const kind = Array.isArray(parsed)
		? `array with ${parsed.length} item(s)`
		: parsed !== null && typeof parsed === "object"
			? `object with ${Object.keys(parsed).length} top-level key(s)`
			: typeof parsed;
	return `JSON ${kind} compressed by Headroom local structural preview.\nPreview:\n${previewText}`;
}

function summarizePlainText(text: string, keepLines: number, originalBytes: number): string | undefined {
	if (!/\S/u.test(text)) return undefined;
	let lineCount = 1;
	let newline = text.indexOf("\n");
	while (newline !== -1) {
		lineCount += 1;
		newline = text.indexOf("\n", newline + 1);
	}
	if (lineCount > keepLines + 4) {
		const headCount = Math.ceil(keepLines / 2);
		const tailCount = Math.floor(keepLines / 2);
		let headEnd = text.length;
		let cursor = 0;
		for (let index = 0; index < headCount; index += 1) {
			const next = text.indexOf("\n", cursor);
			if (next === -1) break;
			headEnd = next;
			cursor = next + 1;
		}
		let tailStart = text.length;
		for (let index = 0; index < tailCount; index += 1) {
			const previous = text.lastIndexOf("\n", tailStart - 1);
			if (previous === -1) {
				tailStart = -1;
				break;
			}
			tailStart = previous;
		}
		const head = text.slice(0, headEnd);
		const tail = tailCount > 0 ? text.slice(tailStart + 1) : "";
		const omitted = Math.max(0, lineCount - headCount - tailCount);
		return `Text output compressed by Headroom local line preview (${lineCount} lines, ${originalBytes} bytes).\nFirst ${headCount} lines:\n${head}\n\n[... ${omitted} lines omitted; retrieve hash for exact content ...]\n\nLast ${tailCount} lines:\n${tail}`;
	}

	const excerpt = Math.max(1_000, Math.floor(MAX_SUMMARY_CHARS / 2));
	const textLength = codePointLength(text);
	if (textLength <= excerpt * 2 + 200) return undefined;
	const head = takeCodePointPrefix(text, excerpt);
	const tail = takeCodePointSuffix(text, excerpt);
	const omitted = Math.max(0, textLength - excerpt * 2);
	return `Text output compressed by Headroom local character preview (${originalBytes} bytes).\nFirst ${excerpt} chars:\n${head}\n\n[... ${omitted} chars omitted; retrieve hash for exact content ...]\n\nLast ${excerpt} chars:\n${tail}`;
}

function shouldSkipToolName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return (
		SKIPPED_TOOL_NAMES.has(normalized) ||
		normalized.endsWith(`:${HEADROOM_RETRIEVE_TOOL_NAME}`) ||
		normalized.includes("spawn_subagent") ||
		normalized.includes("get_command_or_subagent_output") ||
		normalized.includes("get_task_output")
	);
}

function isProtectedContent(text: string): boolean {
	return (
		text.startsWith("<headroom_compressed") ||
		text.startsWith("HEADROOM_ORIGINAL ") ||
		text.startsWith("<headroom_original") ||
		(text.includes(`\`${HEADROOM_RETRIEVE_TOOL_NAME}\``) &&
			text.includes('hash="') &&
			utf8Length(text) < DEFAULT_MIN_CHARS * 2)
	);
}

const PROJECTION_HASH = "0".repeat(64);

function buildCompressedMarker(
	hash: string,
	originalBytes: number,
	toolCallId: string | undefined,
	summary: string,
): string {
	const toolAttribute = toolCallId ? ` tool_call_id="${escapeAttribute(toolCallId)}"` : "";
	return `<headroom_compressed hash="${hash}" original_chars="${originalBytes}"${toolAttribute}>\nOriginal content is stored in this ${APP_NAME} process. Use the \`${HEADROOM_RETRIEVE_TOOL_NAME}\` tool with hash "${hash}" if exact content is needed.\nPrefer \`query\` on \`${HEADROOM_RETRIEVE_TOOL_NAME}\` to fetch middle lines without reloading the full body.\n\n${truncateCodePoints(summary, MAX_SUMMARY_CHARS)}\n</headroom_compressed>`;
}

function retrieveTruncationNotice(maxBytes: number): string {
	return `[… retrieve output truncated at ${maxBytes} bytes; narrow \`query\` or raise max_chars …]`;
}

function filterLines(
	content: string,
	query: string,
	maxMatches: number,
	contextLines: number,
	maxBytes: number,
): string {
	const selectedMatches: number[] = [];
	let totalMatches = 0;
	let totalLines = 0;
	let lineStart = 0;
	let lineIndex = 0;
	let nextMatch = content.indexOf(query);
	while (lineStart <= content.length) {
		const newline = content.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? content.length : newline;
		let matchesLine = false;
		while (nextMatch !== -1 && nextMatch <= lineEnd) {
			if (nextMatch >= lineStart && nextMatch + query.length <= lineEnd) matchesLine = true;
			nextMatch = content.indexOf(query, nextMatch + Math.max(1, query.length));
		}
		if (matchesLine) {
			totalMatches += 1;
			if (selectedMatches.length < maxMatches) selectedMatches.push(lineIndex);
		}
		totalLines = lineIndex + 1;
		if (newline === -1) break;
		lineStart = newline + 1;
		lineIndex += 1;
	}
	if (totalMatches === 0) return `(no lines containing ${JSON.stringify(query)})`;

	const ranges: LineRange[] = [];
	for (const match of selectedMatches) {
		const start = Math.max(0, match - contextLines);
		const end = Math.min(totalLines - 1, match + contextLines);
		const previous = ranges.at(-1);
		if (previous && start <= previous.end + 1) {
			previous.end = Math.max(previous.end, end);
		} else {
			ranges.push({ start, end });
		}
	}

	const output: string[] = [];
	const truncationNotice = retrieveTruncationNotice(maxBytes);
	const collectionLimit = Math.max(0, maxBytes - utf8Length(truncationNotice) - 1);
	let outputBytes = 0;
	let truncated = false;
	const append = (line: string): boolean => {
		const separatorBytes = output.length === 0 ? 0 : 1;
		const remainingBytes = Math.max(0, collectionLimit - outputBytes - separatorBytes);
		const bounded = takeUtf8Prefix(line, remainingBytes);
		if (bounded.length > 0) {
			output.push(bounded);
			outputBytes += separatorBytes + utf8Length(bounded);
		}
		return bounded === line;
	};
	if (totalMatches > selectedMatches.length) {
		truncated = !append(`(showing ${selectedMatches.length} of ${totalMatches} matching lines)`);
	}
	let rangeIndex = 0;
	let previousLine: number | undefined;
	lineStart = 0;
	lineIndex = 0;
	while (!truncated && lineStart <= content.length && rangeIndex < ranges.length) {
		const newline = content.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? content.length : newline;
		while (rangeIndex < ranges.length && lineIndex > ranges[rangeIndex]!.end) rangeIndex += 1;
		const range = ranges[rangeIndex];
		if (range && lineIndex >= range.start && lineIndex <= range.end) {
			if (previousLine !== undefined && lineIndex > previousLine + 1) {
				truncated = !append(`... (lines ${previousLine + 2}-${lineIndex} omitted) ...`);
			}
			if (!truncated) {
				const prefix = `${lineIndex + 1}:`;
				const remainingCodeUnits = Math.max(0, collectionLimit - outputBytes - prefix.length - 1);
				let contentEnd = Math.min(lineEnd, lineStart + remainingCodeUnits);
				if (contentEnd > lineStart && contentEnd < lineEnd) {
					const endCodeUnit = content.charCodeAt(contentEnd - 1);
					const nextCodeUnit = content.charCodeAt(contentEnd);
					if (endCodeUnit >= 0xd800 && endCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
						contentEnd -= 1;
					}
				}
				truncated = !append(`${prefix}${content.slice(lineStart, contentEnd)}`) || contentEnd < lineEnd;
			}
			previousLine = lineIndex;
		}
		if (newline === -1) break;
		lineStart = newline + 1;
		lineIndex += 1;
	}
	if (truncated) output.push(truncationNotice);
	return `${output.join("\n")}\n`;
}

function truncateRetrieveOutput(text: string, maxBytes: number): string {
	if (utf8Length(text) <= maxBytes) return text;
	const notice = retrieveTruncationNotice(maxBytes);
	const head = takeUtf8Prefix(text, Math.max(0, maxBytes - utf8Length(notice) - 2));
	return `${head}\n\n${notice}`;
}

export class HeadroomController {
	private readonly env: NodeJS.ProcessEnv;
	private readonly options: Omit<HeadroomControllerOptions, "env">;
	private enabledOverride: boolean | undefined;
	private readonly entries = new Map<string, HeadroomStoredContent>();
	private readonly compressionCache = new Map<string, CachedCompression>();
	private totalBytes = 0;
	private stats: HeadroomSessionStats = emptySessionStats();

	constructor(options: HeadroomControllerOptions = {}) {
		validatePositiveOption("minChars", options.minChars, MAX_MIN_CHARS);
		validatePositiveOption("maxSegments", options.maxSegments, MAX_SEGMENTS);
		validatePositiveOption("keepLines", options.keepLines, MAX_KEEP_LINES);
		validatePositiveOption("maxStoreEntries", options.maxStoreEntries, MAX_STORE_ENTRIES);
		validatePositiveOption("maxStoreChars", options.maxStoreChars, MAX_STORE_CHARS);
		this.env = options.env ?? process.env;
		this.options = options;
	}

	isEnabled(): boolean {
		if (this.enabledOverride !== undefined) return this.enabledOverride;
		const value = this.env[ENV_HEADROOM];
		return value === undefined ? (this.options.defaultEnabled ?? true) : !isFalsyFlag(value);
	}

	setEnabled(enabled: boolean): void {
		this.enabledOverride = enabled;
		this.env[ENV_HEADROOM] = enabled ? "1" : "0";
	}

	getSessionStats(): HeadroomSessionStats {
		return { ...this.stats };
	}

	getStoreStats(): { entries: number; maxEntries: number; chars: number; maxChars: number } {
		return {
			entries: this.entries.size,
			maxEntries: this.maxStoreEntries(),
			chars: this.totalBytes,
			maxChars: this.maxStoreChars(),
		};
	}

	formatStatus(retrievalAvailable = true): string {
		const store = this.getStoreStats();
		const state = this.isEnabled() ? "enabled" : "disabled";
		const availability = retrievalAvailable ? "" : "; inactive because headroom_retrieve is not enabled";
		return `Headroom ${state}${availability}: ${store.entries}/${store.maxEntries} originals stored (${store.chars}/${store.maxChars} bytes)`;
	}

	formatStats(retrievalAvailable = true): string {
		const store = this.getStoreStats();
		const state = this.isEnabled() ? "enabled" : "disabled";
		const availability = retrievalAvailable ? "" : " (inactive: headroom_retrieve is not enabled)";
		const lastError = this.stats.lastError ? `\nLast error: ${this.stats.lastError}` : "";
		return `Headroom ${state}${availability} (built-in local compression)\nSegments: ${this.stats.compressedSegments}/${this.stats.attemptedSegments} compressed, ${this.stats.failedSegments} failed\nEstimated tokens: ${this.stats.tokensBefore} -> ${this.stats.tokensAfter} (saved ${this.stats.tokensSaved})\nStore: ${store.entries}/${store.maxEntries} originals, ${store.chars}/${store.maxChars} bytes${lastError}`;
	}

	transformContext(messages: AgentMessage[], retrievalAvailable: boolean): AgentMessage[] {
		return this.mapContext(messages, retrievalAvailable, (text, toolCallId, blockIndex) =>
			this.compressContent(text, toolCallId, blockIndex),
		);
	}

	/** Side-effect-free projection used only for pre-request context accounting. */
	projectContext(messages: AgentMessage[], retrievalAvailable: boolean): AgentMessage[] {
		return this.mapContext(messages, retrievalAvailable, (text, toolCallId) => this.projectContent(text, toolCallId));
	}

	private mapContext(
		messages: AgentMessage[],
		retrievalAvailable: boolean,
		mapText: (text: string, toolCallId: string, blockIndex: number) => string | undefined,
	): AgentMessage[] {
		if (!this.isEnabled() || !retrievalAvailable) return messages;
		// Only compress "historical" results the model has already seen. A tool
		// result that is not yet followed by an assistant response is fresh; hiding
		// it behind a preview on first delivery would force an immediate
		// headroom_retrieve round trip for output the model just requested.
		let lastAssistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i]!.role === "assistant") {
				lastAssistantIndex = i;
				break;
			}
		}
		let remaining = this.maxSegments();
		let output: AgentMessage[] | undefined;
		for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
			const message = messages[messageIndex]!;
			let transformed: AgentMessage = message;
			if (
				messageIndex < lastAssistantIndex &&
				remaining > 0 &&
				message.role === "toolResult" &&
				!shouldSkipToolName(message.toolName)
			) {
				let content: ToolResultMessage["content"] | undefined;
				for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
					const block = message.content[blockIndex]!;
					let transformedBlock = block;
					if (remaining > 0 && block.type === "text") {
						const mapped = mapText(block.text, message.toolCallId, blockIndex);
						if (mapped) {
							remaining -= 1;
							transformedBlock = { ...block, text: mapped };
						}
					}
					if (transformedBlock !== block && !content) content = message.content.slice(0, blockIndex);
					content?.push(transformedBlock);
				}
				if (content) transformed = { ...message, content } satisfies ToolResultMessage;
			}
			if (transformed !== message && !output) output = messages.slice(0, messageIndex);
			output?.push(transformed);
		}
		return output ?? messages;
	}

	maybeCompressContent(text: string, toolCallId?: string): string | undefined {
		return this.compressContent(text, toolCallId);
	}

	private projectContent(text: string, toolCallId: string | undefined): string | undefined {
		const originalBytes = utf8Length(text);
		if (originalBytes < this.minChars() || originalBytes > this.maxStoreChars() || isProtectedContent(text)) {
			return undefined;
		}
		const summary = summarizeJson(text, originalBytes) ?? summarizePlainText(text, this.keepLines(), originalBytes);
		if (!summary) return undefined;
		const projected = buildCompressedMarker(PROJECTION_HASH, originalBytes, toolCallId, summary);
		return utf8Length(projected) < originalBytes ? projected : undefined;
	}

	private compressContent(text: string, toolCallId: string | undefined, blockIndex?: number): string | undefined {
		if (!this.isEnabled()) return undefined;
		const originalBytes = utf8Length(text);
		if (originalBytes < this.minChars() || isProtectedContent(text)) return undefined;
		this.stats.attemptedSegments += 1;
		const cacheKey =
			toolCallId === undefined ? undefined : blockIndex === undefined ? toolCallId : `${blockIndex}:${toolCallId}`;
		const maxStoreEntries = this.maxStoreEntries();
		const maxStoreChars = this.maxStoreChars();
		if (originalBytes > maxStoreChars) return this.noteFailure("content exceeds max store chars");
		this.enforceStoreLimits(maxStoreEntries, maxStoreChars);

		const keepLines = this.keepLines();
		const cached = cacheKey ? this.compressionCache.get(cacheKey) : undefined;
		const stored = cached ? this.entries.get(cached.hash) : undefined;
		if (cached && stored?.content === text && stored.toolCallId === toolCallId && cached.keepLines === keepLines) {
			this.recordCompression(cached.originalBytes, cached.markerBytes);
			return cached.marker;
		}

		const hash = createHash("sha256").update(text, "utf8").digest("hex");
		const summary = summarizeJson(text, originalBytes) ?? summarizePlainText(text, keepLines, originalBytes);
		if (!summary) return this.noteFailure("no smaller summary produced");
		const compressed = buildCompressedMarker(hash, originalBytes, toolCallId, summary);
		const compressedBytes = utf8Length(compressed);
		if (compressedBytes >= originalBytes) return this.noteFailure("compressed form not smaller");

		const entry: HeadroomStoredContent = {
			hash,
			content: text,
			originalChars: originalBytes,
			compressedChars: compressedBytes,
			...(toolCallId ? { toolCallId } : {}),
		};
		if (!this.remember(entry, maxStoreEntries, maxStoreChars)) return this.noteFailure("store rejected entry");

		if (cacheKey) {
			this.compressionCache.delete(cacheKey);
			const maxCacheEntries = this.maxCacheEntries(maxStoreEntries);
			while (this.compressionCache.size >= maxCacheEntries) {
				const oldestKey = this.compressionCache.keys().next().value;
				if (oldestKey === undefined) break;
				this.compressionCache.delete(oldestKey);
			}
			this.compressionCache.set(cacheKey, {
				hash,
				keepLines,
				marker: compressed,
				originalBytes,
				markerBytes: compressedBytes,
			});
		}
		this.recordCompression(originalBytes, compressedBytes);
		return compressed;
	}

	retrieve(hash: string): HeadroomStoredContent | undefined {
		const normalized = normalizeHash(hash);
		const entry = normalized ? this.entries.get(normalized) : undefined;
		return entry ? { ...entry } : undefined;
	}

	retrieveFormatted(hash: string, options: HeadroomRetrieveOptions = {}): HeadroomRetrieveResult {
		const normalized = normalizeHash(hash);
		if (!normalized) return { ok: false, reason: "invalid_hash" };
		const entry = this.entries.get(normalized);
		if (!entry) return { ok: false, reason: "not_found" };

		const maxChars = boundedPositiveOption(options.maxChars, DEFAULT_RETRIEVE_MAX_CHARS, MAX_RETRIEVE_CHARS);
		const header = `HEADROOM_ORIGINAL hash=${entry.hash} original_chars=${entry.originalChars}\n`;
		const query = options.query?.trim();
		if (query) {
			const maxMatches = boundedPositiveOption(
				options.maxMatches,
				DEFAULT_RETRIEVE_MAX_MATCHES,
				MAX_RETRIEVE_MATCHES,
			);
			const contextLines = boundedNonNegativeOption(
				options.contextLines,
				DEFAULT_RETRIEVE_CONTEXT_LINES,
				MAX_RETRIEVE_CONTEXT_LINES,
			);
			const body = truncateRetrieveOutput(
				filterLines(entry.content, query, maxMatches, contextLines, maxChars),
				maxChars,
			);
			return {
				ok: true,
				content: `${header}Query filter: ${JSON.stringify(query)} (max_matches=${maxMatches}, context_lines=${contextLines})\nMatching content follows.\n\n${body}`,
			};
		}

		if (entry.originalChars <= maxChars) {
			return { ok: true, content: `${header}Exact original content follows.\n\n${entry.content}` };
		}
		const half = Math.floor(maxChars / 2);
		const { head, tail } = takeUtf8Edges(entry.content, entry.originalChars, half, Math.max(1, half - 200));
		const omitted = Math.max(0, entry.originalChars - utf8Length(head) - utf8Length(tail));
		return {
			ok: true,
			content: `${header}Exact original is ${entry.originalChars} bytes; returning first/last ~${half} bytes (omitted ~${omitted}). Pass \`query\` to fetch middle lines without the full body.\n\n${head}\n\n[... ${omitted} bytes omitted; re-call ${HEADROOM_RETRIEVE_TOOL_NAME} with query=... ...]\n\n${tail}`,
		};
	}

	reset(): void {
		this.enabledOverride = undefined;
		this.entries.clear();
		this.compressionCache.clear();
		this.totalBytes = 0;
		this.stats = emptySessionStats();
	}

	private noteFailure(reason: string): undefined {
		this.stats.failedSegments += 1;
		this.stats.lastError = reason;
		return undefined;
	}

	private recordCompression(originalBytes: number, compressedBytes: number): void {
		const tokensBefore = estimateTokensFromBytes(originalBytes);
		const tokensAfter = estimateTokensFromBytes(compressedBytes);
		this.stats.compressedSegments += 1;
		this.stats.tokensBefore += tokensBefore;
		this.stats.tokensAfter += tokensAfter;
		this.stats.tokensSaved += Math.max(0, tokensBefore - tokensAfter);
	}

	private enforceStoreLimits(maxEntries: number, maxChars: number): void {
		while (this.entries.size > maxEntries || this.totalBytes > maxChars) {
			const oldestHash = this.entries.keys().next().value;
			if (oldestHash === undefined) break;
			const oldest = this.entries.get(oldestHash);
			this.entries.delete(oldestHash);
			if (oldest) this.totalBytes = Math.max(0, this.totalBytes - oldest.originalChars);
		}
		const maxCacheEntries = this.maxCacheEntries(maxEntries);
		while (this.compressionCache.size > maxCacheEntries) {
			const oldestKey = this.compressionCache.keys().next().value;
			if (oldestKey === undefined) break;
			this.compressionCache.delete(oldestKey);
		}
	}

	private maxCacheEntries(maxStoreEntries: number): number {
		return Math.min(maxStoreEntries, Math.max(1, this.maxSegments() * 2));
	}

	private remember(entry: HeadroomStoredContent, maxEntries: number, maxChars: number): boolean {
		if (entry.originalChars > maxChars) return false;
		const existing = this.entries.get(entry.hash);
		if (existing) {
			this.entries.delete(entry.hash);
			this.totalBytes = Math.max(0, this.totalBytes - existing.originalChars);
		}
		while (this.entries.size >= maxEntries || this.totalBytes + entry.originalChars > maxChars) {
			const oldestHash = this.entries.keys().next().value;
			if (oldestHash === undefined) return false;
			const oldest = this.entries.get(oldestHash);
			this.entries.delete(oldestHash);
			if (oldest) this.totalBytes = Math.max(0, this.totalBytes - oldest.originalChars);
		}
		if (this.entries.size >= maxEntries || this.totalBytes + entry.originalChars > maxChars) return false;
		this.entries.set(entry.hash, entry);
		this.totalBytes += entry.originalChars;
		return true;
	}

	private minChars(): number {
		return (
			this.options.minChars ?? positiveInteger(this.env[ENV_HEADROOM_MIN_CHARS], DEFAULT_MIN_CHARS, MAX_MIN_CHARS)
		);
	}

	private maxSegments(): number {
		return (
			this.options.maxSegments ??
			positiveInteger(this.env[ENV_HEADROOM_MAX_SEGMENTS], DEFAULT_MAX_SEGMENTS, MAX_SEGMENTS)
		);
	}

	private keepLines(): number {
		return (
			this.options.keepLines ??
			positiveInteger(this.env[ENV_HEADROOM_KEEP_LINES], DEFAULT_KEEP_LINES, MAX_KEEP_LINES)
		);
	}

	private maxStoreEntries(): number {
		return (
			this.options.maxStoreEntries ??
			positiveInteger(this.env[ENV_HEADROOM_MAX_STORE_ENTRIES], DEFAULT_MAX_STORE_ENTRIES, MAX_STORE_ENTRIES)
		);
	}

	private maxStoreChars(): number {
		return (
			this.options.maxStoreChars ??
			positiveInteger(this.env[ENV_HEADROOM_MAX_STORE_CHARS], DEFAULT_MAX_STORE_CHARS, MAX_STORE_CHARS)
		);
	}
}

export const headroomController = new HeadroomController();

export function transformHeadroomContext(messages: AgentMessage[], retrievalAvailable: boolean): AgentMessage[] {
	return headroomController.transformContext(messages, retrievalAvailable);
}

export function projectHeadroomContext(messages: AgentMessage[], retrievalAvailable: boolean): AgentMessage[] {
	return headroomController.projectContext(messages, retrievalAvailable);
}
