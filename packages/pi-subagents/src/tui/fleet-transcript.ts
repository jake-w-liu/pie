import * as fs from "node:fs";
import * as path from "node:path";
import { getLanguageFromPath, highlightCode, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { safeTerminalText as safeDisplayText } from "../shared/display-text.ts";
import { isTrustedRecordedSessionFile } from "../shared/session-file-trust.ts";

const DEFAULT_MAX_RECORDS = 240;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
const TOOL_PREVIEW_LINES = 7;

function sanitizeJsonDisplayValue(value: unknown): { value: unknown; changed: boolean } {
	if (typeof value === "string") {
		const safe = safeDisplayText(value);
		return { value: safe, changed: safe !== value };
	}
	if (Array.isArray(value)) {
		const sanitized = value.map(sanitizeJsonDisplayValue);
		return {
			value: sanitized.map((entry) => entry.value),
			changed: sanitized.some((entry) => entry.changed),
		};
	}
	if (value && typeof value === "object") {
		let changed = false;
		const sanitized: Record<string, unknown> = Object.create(null);
		for (const [key, nested] of Object.entries(value)) {
			const safeKey = safeDisplayText(key);
			const safeValue = sanitizeJsonDisplayValue(nested);
			sanitized[safeKey] = safeValue.value;
			changed ||= safeKey !== key || safeValue.changed;
		}
		return { value: changed ? sanitized : value, changed };
	}
	return { value, changed: false };
}

function safeToolArgsPayload(payload: string): string {
	try {
		const sanitized = sanitizeJsonDisplayValue(JSON.parse(payload));
		return sanitized.changed ? JSON.stringify(sanitized.value) : safeDisplayText(payload);
	} catch {
		return safeDisplayText(payload);
	}
}

type Theme = ExtensionContext["ui"]["theme"];

export type FleetTranscriptEvent =
	| { kind: "assistant"; text: string; model?: string; timestamp?: number }
	| { kind: "user"; text: string; timestamp?: number }
	| { kind: "tool"; toolCallId?: string; name: string; args?: string; argsPayload?: string; output?: string; outputTruncated?: boolean; status: "running" | "complete" | "error"; error?: string; startedAt?: number; endedAt?: number; timestamp?: number }
	| { kind: "notice"; text: string; tone: "muted" | "warning" | "error"; timestamp?: number };

export interface FleetTranscript {
	path: string;
	events: FleetTranscriptEvent[];
	truncated: boolean;
	warning?: string;
}

export interface FleetTranscriptReadOptions {
	trustedRoots: string[];
	trustedFiles?: string[];
	trustedFileRoot?: string;
	maxRecords?: number;
	maxBytes?: number;
}

interface ParsedTranscriptRecord {
	record?: Record<string, unknown>;
	malformed: boolean;
	byteLength: number;
	event?: FleetTranscriptEvent;
}

interface MutableToolEvent {
	kind: "tool";
	toolCallId?: string;
	name: string;
	args?: string;
	argsPayload?: string;
	output?: string;
	outputTruncated?: boolean;
	status: "running" | "complete" | "error";
	error?: string;
	startedAt?: number;
	endedAt?: number;
	timestamp?: number;
	resultSeen?: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return Boolean(objectValue(error)?.code === "ENOENT");
}

function validateTranscriptPath(filePath: string, trustedRoots: string[], trustedFiles: string[] = [], trustedFileRoot?: string): { resolvedPath?: string; warning?: string } {
	if (trustedRoots.length === 0 && (!trustedFileRoot || trustedFiles.length === 0)) return { warning: `Transcript preview has no trusted root: ${filePath}` };
	const resolvedPath = path.resolve(filePath);
	const recordedCandidate = trustedFileRoot
		&& pathWithin(trustedFileRoot, resolvedPath)
		&& trustedFiles.some((file) => path.resolve(file) === resolvedPath);
	if (!trustedRoots.some((root) => pathWithin(root, resolvedPath)) && !recordedCandidate) {
		return { warning: `Transcript is outside trusted roots: ${filePath}` };
	}
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolvedPath);
	} catch (error) {
		if (isNotFoundError(error)) return {};
		return { warning: `Transcript could not be inspected: ${errorMessage(error)}` };
	}
	if (stat.isSymbolicLink()) return { warning: `Transcript preview refused a symlink: ${filePath}` };
	if (!stat.isFile()) return { warning: `Transcript path is not a file: ${filePath}` };
	try {
		const realPath = fs.realpathSync(resolvedPath);
		const realRoots = trustedRoots
			.filter((root) => fs.existsSync(root))
			.map((root) => fs.realpathSync(root));
		if (!realRoots.some((root) => pathWithin(root, realPath)) && !isTrustedRecordedSessionFile(realPath, trustedFiles, trustedFileRoot)) {
			return { warning: `Transcript resolves outside trusted roots: ${filePath}` };
		}
		return { resolvedPath: realPath };
	} catch (error) {
		return { warning: `Transcript path could not be resolved: ${errorMessage(error)}` };
	}
}

function isCompleteRecord(line: string | undefined): boolean {
	if (!line?.trim()) return false;
	try {
		return objectValue(JSON.parse(line)) !== undefined;
	} catch {
		return false;
	}
}

function readTailLines(filePath: string, maxBytes: number): { lines: string[]; truncated: boolean; warning?: string } {
	let fd: number | undefined;
	try {
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return { lines: [], truncated: false, warning: `Transcript path is not a file: ${filePath}` };
		if (stat.size === 0) return { lines: [], truncated: false };
		const bytesToRead = Math.min(stat.size, maxBytes);
		const start = stat.size - bytesToRead;
		const buffer = Buffer.alloc(bytesToRead);
		const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
		const content = buffer.subarray(0, bytesRead).toString("utf-8");
		const endsWithNewline = content.endsWith("\n");
		let lines = content.split(/\r?\n/);
		if (start > 0 && lines.length > 0) lines = lines.slice(1);
		if (lines.at(-1) === "") lines = lines.slice(0, -1);
		else if (!endsWithNewline && !isCompleteRecord(lines.at(-1))) lines = lines.slice(0, -1);
		return { lines, truncated: start > 0 };
	} catch (error) {
		return { lines: [], truncated: false, warning: `Transcript could not be read: ${errorMessage(error)}` };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function clipMessage(text: string): string {
	if (text.length <= MAX_MESSAGE_CHARS) return text;
	return `${text.slice(0, MAX_MESSAGE_CHARS)}\n\n… message truncated`;
}

const SAFE_TRANSCRIPT_EVENTS = new WeakSet<object>();

function safeTranscriptEvent(event: FleetTranscriptEvent): FleetTranscriptEvent {
	if (SAFE_TRANSCRIPT_EVENTS.has(event)) return event;
	let safe: FleetTranscriptEvent;
	if (event.kind === "assistant") {
		safe = {
			...event,
			text: safeDisplayText(event.text),
			...(event.model ? { model: safeDisplayText(event.model) } : {}),
		};
	} else if (event.kind === "user" || event.kind === "notice") {
		safe = { ...event, text: safeDisplayText(event.text) };
	} else {
		safe = {
			...event,
			name: safeDisplayText(event.name),
			...(event.args !== undefined ? { args: safeDisplayText(event.args) } : {}),
			...(event.argsPayload !== undefined ? { argsPayload: safeToolArgsPayload(event.argsPayload) } : {}),
			...(event.output !== undefined ? { output: safeDisplayText(event.output) } : {}),
			...(event.error !== undefined ? { error: safeDisplayText(event.error) } : {}),
		};
	}
	SAFE_TRANSCRIPT_EVENTS.add(safe);
	return safe;
}

function findTool(
	events: FleetTranscriptEvent[],
	toolCallId: string | undefined,
	name: string | undefined,
): MutableToolEvent | undefined {
	if (toolCallId) {
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index];
			if (event?.kind === "tool" && event.toolCallId === toolCallId) return event as MutableToolEvent;
		}
		return undefined;
	}
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event?.kind !== "tool") continue;
		const tool = event as MutableToolEvent;
		if ((!name || tool.name === name) && !tool.resultSeen) return tool;
	}
	return undefined;
}

function appendTextEvent(
	events: FleetTranscriptEvent[],
	kind: "assistant" | "user",
	text: string,
	metadata: { model?: string; timestamp?: number },
): FleetTranscriptEvent | undefined {
	const clipped = clipMessage(text.trim());
	if (!clipped) return undefined;
	const previous = events.at(-1);
	if (previous?.kind === kind && previous.text === clipped) return undefined;
	const event: FleetTranscriptEvent = { kind, text: clipped, ...metadata };
	events.push(event);
	return event;
}

function sanitizeTranscriptRecord(record: Record<string, unknown>): Record<string, unknown> {
	const safe = { ...record };
	for (const key of ["text", "model", "toolName", "argsPreview"] as const) {
		if (typeof safe[key] === "string") safe[key] = safeDisplayText(safe[key] as string);
	}
	if (typeof safe.argsPayload === "string") safe.argsPayload = safeToolArgsPayload(safe.argsPayload);
	const message = objectValue(safe.message);
	if (message) {
		const safeMessage = { ...message };
		for (const key of ["text", "content", "toolName"] as const) {
			if (typeof safeMessage[key] === "string") safeMessage[key] = safeDisplayText(safeMessage[key] as string);
		}
		safe.message = safeMessage;
	}
	return safe;
}

function parseTranscriptRecord(line: string): ParsedTranscriptRecord {
	const byteLength = Buffer.byteLength(line) + 1;
	if (!line.trim()) return { malformed: false, byteLength };
	try {
		const record = objectValue(JSON.parse(line));
		return record ? { record: sanitizeTranscriptRecord(record), malformed: false, byteLength } : { malformed: true, byteLength };
	} catch {
		return { malformed: true, byteLength };
	}
}

function parseTranscriptLines(lines: Array<string | ParsedTranscriptRecord>, conversationStarted = false): { events: FleetTranscriptEvent[]; malformed: number; explicitTruncation: boolean } {
	const events: FleetTranscriptEvent[] = [];
	const recordsAreDisplaySafe = lines.every((line) => typeof line !== "string");
	let malformed = 0;
	let explicitTruncation = false;
	let assistantSeen = conversationStarted;

	for (const line of lines) {
		if (typeof line === "string" && !line.trim()) continue;
		const parsed = typeof line === "string" ? parseTranscriptRecord(line) : line;
		if (parsed.malformed) {
			malformed++;
			continue;
		}
		if (!parsed.record) continue;
		const record = parsed.record;

		const recordType = stringValue(record.recordType);
		const timestamp = numberValue(record.ts);
		if (recordType === "truncated") {
			explicitTruncation = true;
			continue;
		}
		if (recordType === "tool_start") {
			const name = stringValue(record.toolName) ?? "tool";
			events.push({
				kind: "tool",
				...(stringValue(record.toolCallId) ? { toolCallId: stringValue(record.toolCallId) } : {}),
				name,
				...(stringValue(record.argsPreview) ? { args: stringValue(record.argsPreview) } : {}),
				...(stringValue(record.argsPayload) ? { argsPayload: stringValue(record.argsPayload) } : {}),
				status: "running",
				...(timestamp !== undefined ? { timestamp, startedAt: timestamp } : {}),
			});
			continue;
		}
		if (recordType === "tool_end") {
			const tool = findTool(events, stringValue(record.toolCallId), stringValue(record.toolName));
			if (tool && !tool.resultSeen) tool.status = record.isError === true ? "error" : "complete";
			if (tool && timestamp !== undefined && tool.endedAt === undefined) tool.endedAt = timestamp;
			continue;
		}
		if (recordType === "stderr") {
			const text = stringValue(record.text);
			if (text) {
				parsed.event ??= safeTranscriptEvent({ kind: "notice", text: clipMessage(text), tone: "error", ...(timestamp !== undefined ? { timestamp } : {}) });
				events.push(parsed.event);
			}
			continue;
		}
		if (recordType !== "message") continue;

		const message = objectValue(record.message);
		const role = stringValue(record.role) ?? stringValue(message?.role);
		const text = stringValue(record.text) ?? stringValue(message?.text) ?? stringValue(message?.content);
		if (role === "toolResult" || role === "tool_result") {
			const toolCallId = stringValue(record.toolCallId) ?? stringValue(message?.toolCallId);
			const name = stringValue(record.toolName) ?? stringValue(message?.toolName) ?? "tool";
			const failed = record.isError === true || message?.isError === true;
			let tool = findTool(events, toolCallId, name);
			if (!tool) {
				tool = {
					kind: "tool",
					...(toolCallId ? { toolCallId } : {}),
					name,
					status: failed ? "error" : "complete",
					...(timestamp !== undefined ? { timestamp } : {}),
				};
				events.push(tool);
			}
			if (!tool.resultSeen) {
				tool.resultSeen = true;
				tool.status = failed ? "error" : "complete";
				if (timestamp !== undefined && tool.endedAt === undefined) tool.endedAt = timestamp;
				if (text && (!failed || tool.output === undefined)) {
					tool.output = clipMessage(text);
					tool.outputTruncated = record.outputTruncated === true || text.includes("… payload truncated") || text.includes("[Showing lines");
				}
				if (failed && text) tool.error = clipMessage(text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? text);
			}
			continue;
		}
		if (role === "assistant") {
			assistantSeen = true;
			if (text) {
				if (parsed.event) {
					const previous = events.at(-1);
					const next = parsed.event;
					if (!previous || previous.kind !== "assistant" || next.kind !== "assistant" || previous.text !== next.text) {
						events.push(next);
					}
				} else {
					const event = appendTextEvent(events, "assistant", text, {
						...(stringValue(record.model) ? { model: stringValue(record.model) } : {}),
						...(timestamp !== undefined ? { timestamp } : {}),
					});
					if (event) {
						parsed.event = safeTranscriptEvent(event);
						events[events.length - 1] = parsed.event;
					}
				}
			}
			continue;
		}
		if (role === "user" && assistantSeen && text) {
			if (parsed.event) {
				const previous = events.at(-1);
				const next = parsed.event;
				if (!previous || previous.kind !== "user" || next.kind !== "user" || previous.text !== next.text) events.push(next);
			} else {
				const event = appendTextEvent(events, "user", text, timestamp !== undefined ? { timestamp } : {});
				if (event) {
					parsed.event = safeTranscriptEvent(event);
					events[events.length - 1] = parsed.event;
				}
			}
		}
	}

	for (const event of events) {
		if (event.kind === "tool") delete (event as MutableToolEvent).resultSeen;
	}
	if (recordsAreDisplaySafe) {
		for (const event of events) SAFE_TRANSCRIPT_EVENTS.add(event);
	}
	return { events: recordsAreDisplaySafe ? events : events.map(safeTranscriptEvent), malformed, explicitTruncation };
}

export function readFleetTranscript(filePath: string, options: FleetTranscriptReadOptions): FleetTranscript {
	const validated = validateTranscriptPath(filePath, options.trustedRoots, options.trustedFiles, options.trustedFileRoot);
	if (!validated.resolvedPath) {
		return { path: filePath, events: [], truncated: false, ...(validated.warning ? { warning: safeDisplayText(validated.warning) } : {}) };
	}
	const maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
	const tail = readTailLines(validated.resolvedPath, Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES));
	const recordsOmitted = tail.truncated || tail.lines.length > maxRecords;
	const selectedLines = tail.lines.slice(-maxRecords);
	const parsed = parseTranscriptLines(selectedLines.map(parseTranscriptRecord), recordsOmitted);
	const warnings = [
		tail.warning,
		parsed.malformed > 0 ? `Skipped ${parsed.malformed} malformed transcript record${parsed.malformed === 1 ? "" : "s"}.` : undefined,
	].filter((value): value is string => Boolean(value));
	return {
		path: filePath,
		events: parsed.events,
		truncated: tail.truncated || tail.lines.length > maxRecords || parsed.explicitTruncation,
		...(warnings.length ? { warning: safeDisplayText(warnings.join(" ")) } : {}),
	};
}

interface FleetTranscriptReadCache {
	resolvedPath: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	maxRecords: number;
	maxBytes: number;
	records: ParsedTranscriptRecord[];
	pending: Buffer;
	recordsOmitted: boolean;
	anchor: string;
}

interface IncrementalFleetTranscriptRead {
	transcript: FleetTranscript;
	cache?: FleetTranscriptReadCache;
	bytesRead: number;
	parsedRecords: number;
}

function anchorAt(fd: number, size: number): string {
	const length = Math.min(128, size);
	if (length === 0) return "";
	const buffer = Buffer.alloc(length);
	const bytesRead = fs.readSync(fd, buffer, 0, length, size - length);
	return buffer.subarray(0, bytesRead).toString("base64");
}

function transcriptFromParsedRecords(
	filePath: string,
	records: ParsedTranscriptRecord[],
	pendingBytes: Buffer,
	recordsOmitted: boolean,
	maxRecords: number,
): FleetTranscript {
	const pending = pendingBytes.toString("utf-8");
	const pendingRecord = pending && isCompleteRecord(pending) ? parseTranscriptRecord(pending) : undefined;
	const available = pendingRecord ? [...records, pendingRecord] : records;
	const omitted = recordsOmitted || available.length > maxRecords;
	const parsed = parseTranscriptLines(available.slice(-maxRecords), omitted);
	const warning = parsed.malformed > 0
		? `Skipped ${parsed.malformed} malformed transcript record${parsed.malformed === 1 ? "" : "s"}.`
		: undefined;
	return {
		path: filePath,
		events: parsed.events,
		truncated: omitted || parsed.explicitTruncation,
		...(warning ? { warning: warning } : {}),
	};
}

function fullIncrementalRead(filePath: string, resolvedPath: string, maxRecords: number, maxBytes: number): IncrementalFleetTranscriptRead {
	let fd: number | undefined;
	try {
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return { transcript: { path: filePath, events: [], truncated: false, warning: `Transcript path is not a file: ${filePath}` }, bytesRead: 0, parsedRecords: 0 };
		const bytesToRead = Math.min(stat.size, maxBytes);
		const start = stat.size - bytesToRead;
		const buffer = Buffer.alloc(bytesToRead);
		const bytesRead = bytesToRead > 0 ? fs.readSync(fd, buffer, 0, bytesToRead, start) : 0;
		const content = buffer.subarray(0, bytesRead);
		const lastNewline = content.lastIndexOf(0x0a);
		const completed = lastNewline >= 0 ? content.subarray(0, lastNewline) : Buffer.alloc(0);
		const pending = start > 0 && lastNewline < 0
			? Buffer.alloc(0)
			: lastNewline >= 0 ? content.subarray(lastNewline + 1) : content;
		let lines = completed.length > 0
			? completed.toString("utf-8").split(/\n/).map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
			: [];
		if (start > 0 && lines.length > 0) lines = lines.slice(1);
		const parsedLines = lines.map(parseTranscriptRecord);
		const recordsOmitted = start > 0 || parsedLines.length > maxRecords;
		const records = parsedLines.slice(-maxRecords);
		const cache: FleetTranscriptReadCache = {
			resolvedPath,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			maxRecords,
			maxBytes,
			records,
			pending,
			recordsOmitted,
			anchor: anchorAt(fd, stat.size),
		};
		return {
			transcript: transcriptFromParsedRecords(filePath, records, pending, recordsOmitted, maxRecords),
			cache,
			bytesRead,
			parsedRecords: parsedLines.length + (pending.length > 0 && isCompleteRecord(pending.toString("utf-8")) ? 1 : 0),
		};
	} catch (error) {
		return { transcript: { path: filePath, events: [], truncated: false, warning: `Transcript could not be read: ${errorMessage(error)}` }, bytesRead: 0, parsedRecords: 0 };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

export function readFleetTranscriptIncrementally(
	filePath: string,
	options: FleetTranscriptReadOptions,
	previous?: FleetTranscriptReadCache,
): IncrementalFleetTranscriptRead {
	const validated = validateTranscriptPath(filePath, options.trustedRoots, options.trustedFiles, options.trustedFileRoot);
	if (!validated.resolvedPath) {
		return { transcript: { path: filePath, events: [], truncated: false, ...(validated.warning ? { warning: safeDisplayText(validated.warning) } : {}) }, bytesRead: 0, parsedRecords: 0 };
	}
	const maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
	const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
	if (!previous || previous.resolvedPath !== validated.resolvedPath || previous.maxRecords !== maxRecords || previous.maxBytes !== maxBytes) {
		return fullIncrementalRead(filePath, validated.resolvedPath, maxRecords, maxBytes);
	}
	let fd: number | undefined;
	try {
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		fd = fs.openSync(validated.resolvedPath, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(fd);
		const appendBytes = stat.size - previous.size;
		const canAppend = stat.isFile()
			&& stat.dev === previous.dev
			&& stat.ino === previous.ino
			&& appendBytes >= 0
			&& appendBytes <= maxBytes
			&& anchorAt(fd, previous.size) === previous.anchor;
		if (!canAppend || (appendBytes === 0 && stat.mtimeMs !== previous.mtimeMs)) {
			fs.closeSync(fd);
			fd = undefined;
			return fullIncrementalRead(filePath, validated.resolvedPath, maxRecords, maxBytes);
		}
		if (appendBytes === 0) {
			return { transcript: transcriptFromParsedRecords(filePath, previous.records, previous.pending, previous.recordsOmitted, maxRecords), cache: previous, bytesRead: 0, parsedRecords: 0 };
		}
		const buffer = Buffer.alloc(appendBytes);
		const bytesRead = fs.readSync(fd, buffer, 0, appendBytes, previous.size);
		const content = Buffer.concat([previous.pending, buffer.subarray(0, bytesRead)]);
		const lastNewline = content.lastIndexOf(0x0a);
		const completed = lastNewline >= 0 ? content.subarray(0, lastNewline) : Buffer.alloc(0);
		const pending = lastNewline >= 0 ? content.subarray(lastNewline + 1) : content;
		const lines = completed.length > 0
			? completed.toString("utf-8").split(/\n/).map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
			: [];
		const appendedRecords = lines.map(parseTranscriptRecord);
		const combined = [...previous.records, ...appendedRecords];
		let recordsOmitted = previous.recordsOmitted || combined.length > maxRecords;
		let records = combined.slice(-maxRecords);
		let retainedBytes = pending.length + records.reduce((total, record) => total + record.byteLength, 0);
		while (records.length > 0 && retainedBytes > maxBytes) {
			retainedBytes -= records.shift()!.byteLength;
			recordsOmitted = true;
		}
		if (retainedBytes > maxBytes) {
			fs.closeSync(fd);
			fd = undefined;
			return fullIncrementalRead(filePath, validated.resolvedPath, maxRecords, maxBytes);
		}
		const cache: FleetTranscriptReadCache = {
			...previous,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			records,
			pending,
			recordsOmitted,
			anchor: anchorAt(fd, stat.size),
		};
		return {
			transcript: transcriptFromParsedRecords(filePath, records, pending, recordsOmitted, maxRecords),
			cache,
			bytesRead,
			parsedRecords: appendedRecords.length + (pending.length > 0 && isCompleteRecord(pending.toString("utf-8")) ? 1 : 0),
		};
	} catch {
		if (fd !== undefined) fs.closeSync(fd);
		fd = undefined;
		return fullIncrementalRead(filePath, validated.resolvedPath, maxRecords, maxBytes);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function statusGlyph(event: Extract<FleetTranscriptEvent, { kind: "tool" }>, theme: Theme): string {
	if (event.status === "running") return theme.fg("warning", "●");
	if (event.status === "error") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function jsonScalar(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function parseToolArgs(event: Extract<FleetTranscriptEvent, { kind: "tool" }>): Record<string, unknown> | undefined {
	if (!event.argsPayload) return undefined;
	try {
		return objectValue(JSON.parse(event.argsPayload));
	} catch {
		return undefined;
	}
}

function toolDuration(event: Extract<FleetTranscriptEvent, { kind: "tool" }>): string | undefined {
	if (event.startedAt === undefined || event.endedAt === undefined) return undefined;
	return `${((event.endedAt - event.startedAt) / 1000).toFixed(1)}s`;
}

function renderExpandedTool(
	event: Extract<FleetTranscriptEvent, { kind: "tool" }>,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const args = parseToolArgs(event);
	const glyph = statusGlyph(event, theme);
	const output = event.output ?? event.error;
	const outputColor = event.status === "error" ? "error" : "toolOutput";
	if (event.name === "bash") {
		const command = jsonScalar(args?.command) ?? event.args ?? "(unknown command)";
		lines.push(railLine(`${glyph} ${theme.fg("toolTitle", theme.bold(`$ ${command}`))}`, width, theme));
		if (output) {
			for (const outputLine of output.replace(/\s+$/, "").split(/\r?\n/)) {
				for (const wrapped of renderWrapped(theme.fg(outputColor, outputLine), Math.max(1, width - 4))) {
					lines.push(railLine(`  ${wrapped}`, width, theme));
				}
			}
		}
		const duration = toolDuration(event);
		if (duration) lines.push(railLine(theme.fg("dim", `  Took ${duration}`), width, theme));
		return lines;
	}
	if (event.name === "read") {
		const filePath = jsonScalar(args?.path ?? args?.file_path);
		const language = filePath ? getLanguageFromPath(filePath) : undefined;
		const rendered = !output
			? []
			: event.status === "error"
				? output.split("\n").map((line) => theme.fg("error", line))
				: language
					? highlightCode(output, language)
					: output.split("\n");
		lines.push(railLine(`${glyph} ${theme.fg("toolTitle", theme.bold(`read ${filePath ?? event.args ?? ""}`))}`, width, theme));
		for (const line of rendered) {
			for (const wrapped of renderWrapped(line, Math.max(1, width - 4))) lines.push(railLine(`  ${wrapped}`, width, theme));
		}
		return lines;
	}
	lines.push(railLine(`${glyph} ${theme.fg("toolTitle", theme.bold(event.name))}`, width, theme));
	if (event.argsPayload) {
		lines.push(railLine(theme.fg("dim", "  args"), width, theme));
		for (const argLine of event.argsPayload.split(/\r?\n/)) {
			for (const wrapped of renderWrapped(theme.fg("muted", argLine), Math.max(1, width - 4))) lines.push(railLine(`  ${wrapped}`, width, theme));
		}
	}
	if (output) {
		lines.push(railLine(theme.fg(event.status === "error" ? "error" : "dim", event.status === "error" ? "  error" : "  output"), width, theme));
		for (const outputLine of output.split(/\r?\n/)) {
			for (const wrapped of renderWrapped(theme.fg(outputColor, outputLine), Math.max(1, width - 4))) lines.push(railLine(`  ${wrapped}`, width, theme));
		}
	}
	return lines;
}

function bounded(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width));
}

function railLine(content: string, width: number, theme: Theme): string {
	return bounded(`${theme.fg("borderMuted", "│")} ${content}`, width);
}

function renderWrapped(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width));
}

export function renderFleetTranscript(
	transcript: FleetTranscript,
	width: number,
	theme: Theme,
	markdownTheme: MarkdownTheme,
	options: { expandedTools?: boolean } = {},
): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	if (transcript.truncated) lines.push(bounded(theme.fg("dim", "↑ Earlier activity omitted"), width));
	if (transcript.warning) {
		for (const line of renderWrapped(safeDisplayText(transcript.warning), Math.max(1, width - 2))) {
			lines.push(bounded(`${theme.fg("warning", "!")} ${theme.fg("warning", line)}`, width));
		}
	}

	for (const rawEvent of transcript.events) {
		const event = safeTranscriptEvent(rawEvent);
		if (event.kind === "tool") {
			if (options.expandedTools && (event.output || event.argsPayload || event.error)) {
				lines.push(...renderExpandedTool(event, width, theme));
				lines.push(railLine(theme.fg("dim", "  x to collapse"), width, theme));
				continue;
			}
			const title = theme.fg("toolTitle", theme.bold(event.name));
			const args = event.args ? ` ${theme.fg("dim", event.args)}` : "";
			const suffix = event.status === "running" ? theme.fg("warning", " running") : "";
			lines.push(bounded(`${theme.fg("borderMuted", "├─")} ${statusGlyph(event, theme)} ${title}${args}${suffix}`, width));
			if (event.output && event.status !== "error" && event.name === "bash") {
				const outputLines = event.output.replace(/\s+$/, "").split(/\r?\n/);
				const visible = outputLines.slice(-TOOL_PREVIEW_LINES);
				const hidden = Math.max(0, outputLines.length - visible.length);
				for (const outputLine of visible) {
					for (const wrapped of renderWrapped(theme.fg("toolOutput", outputLine), Math.max(1, width - 4))) {
						lines.push(railLine(`  ${wrapped}`, width, theme));
					}
				}
				if (hidden > 0) lines.push(railLine(theme.fg("dim", `  … ${hidden} earlier lines · x to expand`), width, theme));
				const duration = toolDuration(event);
				lines.push(railLine(theme.fg("dim", `  Took${duration ? ` ${duration}` : ""}`), width, theme));
			} else if (event.output && event.status !== "error") {
				const summary = truncateToWidth(event.output.replace(/\s+/g, " ").trim(), Math.max(1, width - 18), "…");
				if (summary) lines.push(railLine(theme.fg("dim", `  ${summary} · x to expand`), width, theme));
			}
			if (event.error) {
				for (const errorLine of renderWrapped(event.error, Math.max(1, width - 4))) {
					lines.push(railLine(theme.fg("error", `  ${errorLine}`), width, theme));
				}
			}
			continue;
		}
		if (event.kind === "notice") {
			const color = event.tone === "error" ? "error" : event.tone === "warning" ? "warning" : "dim";
			for (const noticeLine of renderWrapped(event.text, Math.max(1, width - 2))) {
				lines.push(railLine(theme.fg(color, noticeLine), width, theme));
			}
			continue;
		}

		const assistant = event.kind === "assistant";
		const label = assistant ? "Assistant" : "Supervisor";
		const marker = assistant ? theme.fg("accent", "◆") : theme.fg("warning", "◇");
		const model = assistant && event.model ? theme.fg("dim", ` · ${event.model}`) : "";
		lines.push(bounded(`${marker} ${theme.bold(label)}${model}`, width));
		if (assistant) {
			const rendered = new Markdown(event.text, 0, 0, markdownTheme).render(Math.max(1, width - 2));
			for (const markdownLine of rendered) lines.push(railLine(markdownLine, width, theme));
		} else {
			for (const userLine of renderWrapped(event.text, Math.max(1, width - 2))) {
				lines.push(railLine(userLine, width, theme));
			}
		}
		lines.push(theme.fg("borderMuted", "│"));
	}

	while (lines.length > 0 && visibleWidth(lines.at(-1) ?? "") === 1) lines.pop();
	return lines;
}
