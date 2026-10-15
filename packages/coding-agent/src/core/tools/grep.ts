import { stat as fsStat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	outputMode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
			description:
				"'content' returns matching lines grouped by file (default). 'files_with_matches' returns only the matching file paths, which is cheaper and better for locating the right file before reading it. 'count' returns the total number of matches.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of matches to return for outputMode 'content' (default: 20)" }),
	),
});

export const grepToolSystemPromptContribution = {
	snippet:
		"Search file contents for a pattern. Default outputMode 'content' groups matches by file; use outputMode 'files_with_matches' to list only matching files (locate first, then read), or 'count' for a total (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;

/** How grep results are returned to the caller. */
export type GrepOutputMode = "content" | "files_with_matches" | "count";

const DEFAULT_LIMIT = 20;

/** Search errors quoted in a result; enough to name the unreadable paths without flooding it. */
const MAX_REPORTED_SEARCH_ERRORS = 5;

export function createUtf8LineDecoder(
	onLine: (line: string) => void,
	delimiter: string = "\n",
): {
	write: (chunk: Buffer) => void;
	end: () => void;
} {
	const decoder = new StringDecoder("utf8");
	// Pieces of the current, still unterminated record. Only newly decoded text is searched for
	// the delimiter, so a record spanning many chunks (rg's JSON for a minified file) costs
	// linear time.
	let partialLine: string[] = [];
	let ended = false;
	const push = (text: string) => {
		let lineStart = 0;
		for (let newline = text.indexOf(delimiter); newline !== -1; newline = text.indexOf(delimiter, lineStart)) {
			partialLine.push(text.slice(lineStart, newline));
			const line = partialLine.join("");
			partialLine = [];
			onLine(line);
			lineStart = newline + delimiter.length;
		}
		if (lineStart < text.length) partialLine.push(text.slice(lineStart));
	};
	return {
		write(chunk) {
			if (ended) return;
			push(decoder.write(chunk));
		},
		end() {
			if (ended) return;
			ended = true;
			push(decoder.end());
			if (partialLine.length > 0) onLine(partialLine.join(""));
			partialLine = [];
		},
	};
}

/** rg's JSON carries text that is not valid UTF-8 as base64 `bytes` instead of `text`. */
function decodeRgText(data: { text?: unknown; bytes?: unknown } | undefined): string {
	if (typeof data?.text === "string") return data.text;
	if (typeof data?.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf-8");
	return "";
}

/** Summarize rg's stderr for a result that is still returned despite some search errors. */
function formatSearchErrors(stderr: string): string {
	const errors = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const summary = "Some paths could not be searched, so results may be incomplete";
	if (errors.length === 0) return `${summary}.`;
	const shown = errors.slice(0, MAX_REPORTED_SEARCH_ERRORS).join("; ");
	const more =
		errors.length > MAX_REPORTED_SEARCH_ERRORS ? `; and ${errors.length - MAX_REPORTED_SEARCH_ERRORS} more` : "";
	return `${summary}: ${shown}${more}`;
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 *
 * Only the directory probe is pluggable. `readFile` was removed together with
 * the re-read path: context lines now come from ripgrep's own context events,
 * so the tool no longer opens every matched file a second time.
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines grouped by file with file paths and line numbers. Use outputMode "files_with_matches" to list only matching files, or "count" for a total. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				outputMode = "content",
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				outputMode?: GrepOutputMode;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						// Cancellation is registered before any awaited setup: the abort
						// handler is installed after `isDirectory` resolves, so aborting
						// during that await was missed and ripgrep still ran to completion.
						let abortedEarly = false;
						const onEarlyAbort = (): void => {
							abortedEarly = true;
							settle(() => reject(new Error("Operation aborted")));
						};
						if (signal?.aborted) {
							onEarlyAbort();
							return;
						}
						signal?.addEventListener("abort", onEarlyAbort, { once: true });

						const rgPath = await ensureTool("rg");
						if (!rgPath) {
							signal?.removeEventListener("abort", onEarlyAbort);
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							signal?.removeEventListener("abort", onEarlyAbort);
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}
						// The child installs its own listener that kills the process; drop the
						// setup-phase one so an abort is not reported twice.
						signal?.removeEventListener("abort", onEarlyAbort);
						if (abortedEarly) return;

						const contextValue = context && context > 0 ? context : 0;
						// Only 'content' mode stops at the match limit; 'files_with_matches' and
						// 'count' need the full result set.
						const stopAtLimit = outputMode === "content";
						// ripgrep prints raw paths for "-l" (and for "-c" over a directory). Request
						// NUL termination there so a path containing a newline is not split into two
						// bogus paths. A single-file "-c" prints only the bare count, so it stays
						// line-based.
						const nulDelimited = outputMode === "files_with_matches" || (outputMode === "count" && isDirectory);
						const effectiveLimit = stopAtLimit ? Math.max(1, limit ?? DEFAULT_LIMIT) : Number.POSITIVE_INFINITY;
						const formatPath = (reportedPath: string): string => {
							// rg reports paths relative to its working directory, the search directory.
							const filePath = path.resolve(searchPath, reportedPath);
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								// Containment must test path components, not a string prefix: a legal
								// first component such as "..cache" also starts with "..".
								const isInside =
									relative === "" ||
									(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
								if (relative && isInside) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						// rg's own engine work (traversal + SIMD search) dominates; the output
						// format is nearly free by comparison. So pick the narrowest format
						// each mode can use and stop paying for what it does not need:
						//   -l  files_with_matches  rg stops at the first hit per file
						//   -c  count               one number per file instead of a match event
						//   --json  content        the only format that carries a path and a
						//       line number unambiguously on Windows, where "C:\x" and
						//       "dir:name" both contain the field separator
						// Context is taken from rg's context events rather than re-reading
						// each matched file, which also removes the unbounded per-file line
						// cache the old path kept for the whole run.
						// --no-config keeps a user RIPGREP_CONFIG_PATH from injecting flags
						// that break these assumptions.
						const args: string[] = ["--no-config", "--color=never", "--hidden", "--glob", "!**/.git/**"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						// rg matches a glob containing "/" relative to its working directory, so it runs
						// from the search directory: "src/**/*.ts" then means <path>/src/**/*.ts. A leading
						// "./" never matches in rg's gitignore-style globs and is dropped.
						if (glob) args.push("--glob", glob.replace(/^(!?)(?:\.\/)+/, "$1"));
						if (outputMode === "files_with_matches") {
							args.push("-l");
						} else if (outputMode === "count") {
							args.push("-c");
						} else {
							if (contextValue > 0) args.push("-C", String(contextValue));
							args.push("--json");
						}
						if (nulDelimited) args.push("--null");
						args.push("--", pattern, isDirectory ? "." : searchPath);

						const child = spawn(rgPath, args, {
							cwd: isDirectory ? searchPath : undefined,
							stdio: ["ignore", "pipe", "pipe"],
						});
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						let trailingContextRemaining = 0;
						const outputLines: string[] = [];

						// Paths seen in "-l" mode, in first-seen order.
						const matchedFiles: string[] = [];
						const seenFiles = new Set<string>();
						// "-c" over a directory writes "<path>\0<count>\n" per file, so NUL records
						// alternate: a path, then the previous file's count followed by the next path.
						// This tracks whether the next record is a path.
						let countHavePath = false;
						// Current begin..end block in "--json -C" mode.
						let blockFile: string | undefined;
						let blockLines: string[] | undefined;
						// Last file whose matches were written, for the "=== path ===" grouping used
						// when no context was requested.
						let lastFile: string | undefined;

						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						const cleanup = () => {
							child.stdout?.removeAllListeners();
							signal?.removeEventListener("abort", onAbort);
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Emit a finished context block. rg already merges nearby hits into a single
						// block and orders the lines, so nothing here re-reads the file.
						const flushBlock = (): void => {
							if (blockFile === undefined || !blockLines || blockLines.length === 0) {
								blockFile = undefined;
								blockLines = undefined;
								return;
							}
							if (outputLines.length > 0) outputLines.push("");
							outputLines.push(`=== ${blockFile} ===`, ...blockLines);
							blockFile = undefined;
							blockLines = undefined;
						};

						const pushContentLine = (
							relativePath: string,
							lineNumber: number,
							rawText: string,
							isMatch: boolean,
						): void => {
							const sanitized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
							const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
							if (wasTruncated) linesTruncated = true;
							blockLines?.push(
								isMatch
									? `${relativePath}:${lineNumber}: ${truncatedText}`
									: `${relativePath}-${lineNumber}- ${truncatedText}`,
							);
						};

						// "-c" prints "<path>:<count>", except when ripgrep is handed a single file,
						// where it prints the bare count. A Windows path already contains a colon for
						// the drive letter, so the count is whatever follows the last one.
						const addCountLine = (line: string): void => {
							const colon = line.lastIndexOf(":");
							const count = Number.parseInt(colon < 0 ? line : line.slice(colon + 1), 10);
							if (Number.isFinite(count)) matchCount += count;
						};

						const handleNulRecord = (rawRecord: string): void => {
							if (outputMode === "files_with_matches") {
								if (rawRecord.length === 0) return;
								if (!seenFiles.has(rawRecord)) {
									seenFiles.add(rawRecord);
									matchedFiles.push(rawRecord);
									// "-l" reports one record per matching file and no match events, so
									// count the file here to keep the "no matches" check below honest.
									matchCount++;
								}
								return;
							}
							if (!countHavePath) {
								countHavePath = true;
								return;
							}
							const newline = rawRecord.indexOf("\n");
							const countText = newline === -1 ? rawRecord : rawRecord.slice(0, newline);
							const parsed = Number.parseInt(countText.trim(), 10);
							if (Number.isFinite(parsed)) matchCount += parsed;
							const nextPath = newline === -1 ? "" : rawRecord.slice(newline + 1);
							countHavePath = nextPath !== "";
						};

						const handleLine = (rawLine: string): void => {
							const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
							if (line.length === 0) return;

							if (outputMode === "files_with_matches") {
								if (!seenFiles.has(line)) {
									seenFiles.add(line);
									matchedFiles.push(line);
									// "-l" reports one line per matching file and no match events, so
									// count the file here to keep the "no matches" check below honest.
									matchCount++;
								}
								return;
							}
							if (outputMode === "count") {
								addCountLine(line);
								return;
							}

							// Content mode. "--json" is the only format that carries the path verbatim,
							// which is what makes the path/line split unambiguous on Windows.
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							const filePath = event.data?.path?.text;
							if (typeof filePath !== "string") return;
							const relativePath = formatPath(filePath);

							if (event.type === "begin") {
								flushBlock();
								blockFile = relativePath;
								blockLines = [];
								return;
							}
							if (event.type === "end") {
								flushBlock();
								if (trailingContextRemaining > 0) stopChild(true);
								return;
							}
							if (event.type === "context") {
								if (matchLimitReached && trailingContextRemaining === 0) return;
								const contextLine = event.data?.line_number;
								if (typeof contextLine === "number" && blockLines) {
									pushContentLine(relativePath, contextLine, decodeRgText(event.data?.lines), false);
									if (trailingContextRemaining > 0 && --trailingContextRemaining === 0) stopChild(true);
								}
								return;
							}
							if (event.type !== "match") return;
							if (matchCount >= effectiveLimit) {
								const contextLine = event.data?.line_number;
								if (trailingContextRemaining > 0 && typeof contextLine === "number" && blockLines) {
									pushContentLine(relativePath, contextLine, decodeRgText(event.data?.lines), false);
									if (--trailingContextRemaining === 0) stopChild(true);
								}
								return;
							}

							matchCount++;
							const lineNumber = event.data?.line_number;
							if (typeof lineNumber !== "number") return;

							if (contextValue > 0) {
								// Inside a begin..end block; rg already ordered the lines.
								pushContentLine(relativePath, lineNumber, decodeRgText(event.data?.lines), true);
							} else {
								if (lastFile !== relativePath) {
									if (outputLines.length > 0) outputLines.push("");
									outputLines.push(`=== ${relativePath} ===`);
									lastFile = relativePath;
								}
								blockLines = [];
								pushContentLine(relativePath, lineNumber, decodeRgText(event.data?.lines), true);
								outputLines.push(...blockLines);
								blockLines = undefined;
							}

							if (matchCount >= effectiveLimit) {
								matchLimitReached = true;
								if (stopAtLimit) {
									if (contextValue > 0) trailingContextRemaining = contextValue;
									else stopChild(true);
								}
							}
						};

						// Split stdout without corrupting code points divided between chunks. Modes
						// that print raw paths frame records on NUL instead of newline.
						const lineDecoder = createUtf8LineDecoder(
							nulDelimited ? handleNulRecord : handleLine,
							nulDelimited ? "\0" : "\n",
						);
						child.stdout?.on("data", lineDecoder.write);
						// Drain whatever is still buffered and close any open block. Idempotent: the
						// "end" handler already did this in the common case, and "close" calls it
						// again for a child that was killed before stdout reported end.
						const finishStreaming = (): void => {
							lineDecoder.end();
							flushBlock();
						};
						child.stdout?.on("end", finishStreaming);

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", (code) => {
							// A child killed at the match limit can close without ever emitting
							// stdout "end", so drain the buffer before dropping the listeners.
							finishStreaming();
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							// rg exits 2 when any path could not be searched (for example a directory without
							// read permission), even when other files matched. Keep those matches and report
							// the errors with them.
							const partialResults = code === 2 && matchCount > 0;
							if (!killedDueToLimit && code !== 0 && code !== 1 && !partialResults) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							const searchErrors = partialResults ? formatSearchErrors(stderr) : undefined;
							if (matchCount === 0) {
								const text = outputMode === "count" ? "0" : "No matches found";
								settle(() => resolve({ content: [{ type: "text", text }], details: undefined }));
								return;
							}

							if (outputMode === "files_with_matches") {
								// The advertised 50KB ceiling applies to every output mode. Thousands
								// of matching paths otherwise produced an unbounded result the model
								// had to re-read and the caller had to hold in memory.
								const rawOutput = matchedFiles.map((filePath) => formatPath(filePath)).join("\n");
								const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
								let text = truncation.truncated
									? `${truncation.content}\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached. Narrow the path or pattern to see more files.]`
									: rawOutput;
								if (searchErrors) text += `\n\n[${searchErrors}]`;
								settle(() =>
									resolve({
										content: [{ type: "text", text }],
										details: truncation.truncated ? { truncation } : undefined,
									}),
								);
								return;
							}

							if (outputMode === "count") {
								const text = searchErrors ? `${matchCount}\n\n[${searchErrors}]` : String(matchCount);
								settle(() => resolve({ content: [{ type: "text", text }], details: undefined }));
								return;
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (searchErrors) notices.push(searchErrors);
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
