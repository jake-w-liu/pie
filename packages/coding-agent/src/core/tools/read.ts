import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import {
	type AgentTool,
	getUnreadableContentReason,
	getUnreadableFileKindReason,
	getUnreadablePathReason,
	isPdfContent,
	isPdfPath,
	type ReadFileKind,
	TEXT_SNIFF_BYTES,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { extractPdfReadText, MAX_PDF_BYTES, MAX_PDF_PAGES_PER_READ } from "./pdf-read.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	// Integer with a positive minimum, not a bare Number: `limit: 0`, a negative limit
	// and fractional limits all passed schema validation, and the negative/fractional
	// cases then produced wrong content plus continuation notices with impossible
	// counts and offsets ("2.5 more lines ... offset=2.5").
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
	pages: Type.Optional(
		Type.String({
			description: `Page range for PDF files, for example "3", "1-5", or "10-" (maximum ${MAX_PDF_PAGES_PER_READ} pages per read)`,
		}),
	),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Report the file size in bytes without reading the file, when the backend can. */
	fileSize?: (absolutePath: string) => Promise<number | undefined>;
	/** Classify the path without reading it, when the backend can. */
	fileKind?: (absolutePath: string) => Promise<ReadFileKind | undefined>;
	/** Read at most `byteCount` leading bytes, when the backend can. */
	readHead?: (absolutePath: string, byteCount: number) => Promise<Uint8Array | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	fileSize: async (path) => {
		try {
			return (await fsStat(path)).size;
		} catch {
			return undefined;
		}
	},
	fileKind: async (path) => {
		try {
			const stats = await fsStat(path);
			if (stats.isFile()) return "file";
			if (stats.isDirectory()) return "directory";
			return "other";
		} catch {
			// `access` already reports missing or unreadable paths.
			return undefined;
		}
	},
	readHead: async (path, byteCount) => {
		const handle = await fsOpen(path, "r");
		try {
			const head = Buffer.allocUnsafe(byteCount);
			const { bytesRead } = await handle.read(head, 0, byteCount, 0);
			return head.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/**
	 * Model used to describe images when the active model cannot accept them, as `provider/id`
	 * or a bare model id. Unset (the default) leaves images undescribed.
	 */
	visionFallbackModel?: string;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number; pages?: string };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.pages) return theme.fg("warning", ` pages=${args.pages}`);
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/**
 * Read a PDF as text. Returns undefined when the path is not a PDF or the file turns out not
 * to be PDF content, so the caller can fall back to reading it as text.
 */
async function readPdfContent(
	ops: ReadOperations,
	absolutePath: string,
	pages: string | undefined,
	signal: AbortSignal | undefined,
): Promise<(TextContent | ImageContent)[] | undefined> {
	if (!isPdfPath(absolutePath)) return undefined;

	// Confirm the header from a small read first: a text file that merely ends in `.pdf` stays
	// readable as text, and an oversized non-PDF is not rejected by the PDF size guard.
	const head = ops.readHead ? await ops.readHead(absolutePath, 1024) : undefined;
	if (head !== undefined && !isPdfContent(head)) return undefined;

	const size = await ops.fileSize?.(absolutePath);
	if (size !== undefined && size > MAX_PDF_BYTES) {
		throw new Error(
			`Cannot read ${absolutePath}: the file is ${formatSize(size)}, above the read tool's ${formatSize(MAX_PDF_BYTES)} PDF limit.`,
		);
	}

	const buffer = await ops.readFile(absolutePath);
	if (!isPdfContent(buffer)) return undefined;

	return [{ type: "text", text: await extractPdfReadText(buffer, pages, signal) }];
}

const VISION_FALLBACK_INSTRUCTION =
	"Describe this image for a coding agent that cannot view images. Transcribe visible text verbatim, including error messages and file paths, then describe layout, UI state, and diagrams. Do not speculate about anything not visible.";

/** Upper bound on a fallback description so a stalled provider cannot block the read forever. */
const VISION_FALLBACK_DEADLINE_MS = 60_000;

/** Distinct image paths whose digests are remembered for re-read deduplication. */
const SENT_IMAGE_CACHE_LIMIT = 256;

/**
 * Describe an image with a configured vision-capable model. Only used when the active model
 * cannot accept images. Failures never fail the read; they are reported in the result text.
 */
async function describeImageWithFallback(options: {
	ctx: ExtensionContext | undefined;
	modelSpec: string;
	image: { data: string; mimeType: string };
	signal: AbortSignal | undefined;
}): Promise<{ ok: true; description: string } | { ok: false; error: string }> {
	const { ctx, modelSpec, image, signal } = options;
	if (!ctx?.modelRegistry) return { ok: false, error: "no model registry available" };

	const model = resolveVisionModel(ctx.modelRegistry, modelSpec);
	if (!model) return { ok: false, error: `model "${modelSpec}" is not available` };
	if (!model.input.includes("image")) return { ok: false, error: `model "${modelSpec}" cannot accept images` };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, error: `no credentials for ${model.provider}/${model.id}` };

	const message: UserMessage = {
		role: "user",
		content: [
			{ type: "text", text: VISION_FALLBACK_INSTRUCTION },
			{ type: "image", data: image.data, mimeType: image.mimeType },
		],
		timestamp: Date.now(),
	};

	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), VISION_FALLBACK_DEADLINE_MS);
	const completionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

	try {
		const response = await completeSimple(
			model,
			{ messages: [message] },
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: completionSignal },
		);
		// pi-ai encodes provider and runtime failures in the resolved message, not as a throw.
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			const detail = response.errorMessage?.trim();
			if (controller.signal.aborted)
				return { ok: false, error: `timed out after ${VISION_FALLBACK_DEADLINE_MS / 1000}s` };
			return { ok: false, error: detail || `model stopped with ${response.stopReason}` };
		}
		const description = response.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (!description) return { ok: false, error: `model returned no text (stop reason: ${response.stopReason})` };
		return { ok: true, description };
	} catch (error) {
		if (signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: controller.signal.aborted ? `timed out after ${VISION_FALLBACK_DEADLINE_MS / 1000}s` : reason,
		};
	} finally {
		clearTimeout(deadline);
	}
}

/** Resolve `provider/id` (optionally through a routing provider) or a bare model id. */
function resolveVisionModel(registry: ModelRegistry, spec: string): Model<Api> | undefined {
	const available = registry.getAvailable();
	const separator = spec.indexOf("/");
	if (separator <= 0) return available.find((model) => model.id === spec);

	const provider = spec.slice(0, separator);
	const id = spec.slice(separator + 1);
	const exact = available.find((model) => model.provider === provider && model.id === id);
	if (exact) return exact;
	const routed = available.find((model) => model.id === `${provider}/${id}`);
	return routed ?? registry.find(provider, id);
}

/**
 * Whether an earlier tool result is still part of the context that will be sent to the model.
 * Compaction drops summarized entries, and image deduplication must not claim an earlier image
 * is still available after it was summarized away.
 */
function isToolResultInContext(ctx: ExtensionContext | undefined, toolCallId: string): boolean {
	if (!ctx) return false;
	try {
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; toolCallId?: string };
			if (message.role === "toolResult" && message.toolCallId === toolCallId) return true;
		}
	} catch {
		// A stale extension runner throws; treat the earlier result as unavailable.
		return false;
	}
	return false;
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

async function readTextWindow(
	filePath: string,
	startLine: number,
	maxLines: number,
	signal?: AbortSignal,
): Promise<{ lines: string[]; totalLines: number }> {
	const lines: string[] = [];
	let lineIndex = 0;
	let currentLineParts: Buffer[] = [];
	let hasUnterminatedBytes = false;
	let firstChunkChecked = false;
	const shouldRetain = () => lineIndex >= startLine && lineIndex < startLine + maxLines;
	const finishRetainedLine = () => {
		if (!shouldRetain()) return;
		lines.push(Buffer.concat(currentLineParts).toString("utf8"));
		currentLineParts = [];
	};

	for await (const chunk of createReadStream(filePath, { signal })) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (!firstChunkChecked) {
			firstChunkChecked = true;
			const reason = getUnreadableContentReason(filePath, buffer.subarray(0, TEXT_SNIFF_BYTES));
			if (reason) throw new Error(reason);
		}
		let start = 0;
		for (let newline = buffer.indexOf(0x0a, start); newline !== -1; newline = buffer.indexOf(0x0a, start)) {
			if (shouldRetain()) currentLineParts.push(buffer.subarray(start, newline));
			finishRetainedLine();
			lineIndex++;
			start = newline + 1;
			hasUnterminatedBytes = false;
		}
		if (start < buffer.length) {
			if (shouldRetain()) currentLineParts.push(buffer.subarray(start));
			hasUnterminatedBytes = true;
		}
	}
	if (hasUnterminatedBytes) {
		finishRetainedLine();
		lineIndex++;
	}
	return { lines, totalLines: lineIndex };
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const visionFallbackModel = options?.visionFallbackModel;
	const ops = options?.operations ?? defaultReadOperations;
	// Path to the digest of the image last sent for it in this session, so an identical re-read
	// can answer with a stub while the earlier image is still in context.
	const sentImages = new Map<string, { digest: string; toolCallId: string }>();
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files, images (jpg, png, gif, webp, bmp), and PDFs. Images are sent as attachments; PDFs are converted to text (use pages for a page range). For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			toolCallId,
			{ path, offset, limit, pages }: { path: string; offset?: number; limit?: number; pages?: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					// The schema rejects these, but `execute` is also reachable directly
					// through the SDK without schema validation.
					if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
						reject(new Error("offset must be an integer >= 1"));
						return;
					}
					if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
						reject(new Error("limit must be an integer >= 1"));
						return;
					}
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const pathReason = getUnreadablePathReason(absolutePath);
							if (pathReason) throw new Error(pathReason);
							const kind = await ops.fileKind?.(absolutePath);
							if (kind !== undefined) {
								const kindReason = getUnreadableFileKindReason(absolutePath, kind);
								if (kindReason) throw new Error(kindReason);
							}
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							const pdfContent = mimeType ? undefined : await readPdfContent(ops, absolutePath, pages, signal);
							if (aborted) return;
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const previous = sentImages.get(absolutePath);
								const digest = previous === undefined ? undefined : hashBytes(buffer);
								if (previous && digest === previous.digest && isToolResultInContext(ctx, previous.toolCallId)) {
									// The identical image is still in the conversation. Re-sending it would
									// duplicate the image tokens without adding information.
									content = [
										{
											type: "text",
											text: `Read image file [${mimeType}]\n[Identical to the earlier read of this path in this session; that image is still in context.]`,
										},
									];
								} else {
									const processed = await processImage(buffer, mimeType, { autoResizeImages, signal });
									if (!processed.ok) {
										let textNote = `Read image file [${mimeType}]\n${processed.message}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										let textNote = `Read image file [${processed.mimeType}]`;
										if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
										if (nonVisionImageNote && visionFallbackModel) {
											const described = await describeImageWithFallback({
												ctx,
												modelSpec: visionFallbackModel,
												image: { data: processed.data, mimeType: processed.mimeType },
												signal,
											});
											textNote += described.ok
												? `\n${nonVisionImageNote}\n[Image described by ${visionFallbackModel}]\n${described.description}`
												: `\n${nonVisionImageNote}\n[Vision fallback failed: ${described.error}]`;
										} else if (nonVisionImageNote) {
											textNote += `\n${nonVisionImageNote}`;
										}
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: processed.data, mimeType: processed.mimeType },
										];
										sentImages.set(absolutePath, { digest: digest ?? hashBytes(buffer), toolCallId });
										// Bound the map: only recent paths can still match a live result.
										if (sentImages.size > SENT_IMAGE_CACHE_LIMIT) {
											const oldest = sentImages.keys().next();
											if (!oldest.done) sentImages.delete(oldest.value);
										}
									}
								}
							} else if (pdfContent) {
								content = pdfContent;
							} else {
								// Read only the requested output window while still counting the file's
								// lines. This keeps memory bounded for large, newline-heavy files.
								const startLine = offset === undefined ? 0 : offset - 1;
								const startLineDisplay = startLine + 1;
								const retainedLineLimit = limit ?? DEFAULT_MAX_LINES + 1;
								let allLines: string[];
								let totalFileLines: number;
								if (ops === defaultReadOperations) {
									const window = await readTextWindow(absolutePath, startLine, retainedLineLimit, signal);
									allLines = window.lines;
									totalFileLines = window.totalLines || 1;
									if (window.totalLines === 0 && startLine === 0) allLines = [""];
								} else {
									const buffer = await ops.readFile(absolutePath);
									const contentReason = getUnreadableContentReason(
										absolutePath,
										buffer.subarray(0, TEXT_SNIFF_BYTES),
									);
									if (contentReason) throw new Error(contentReason);
									const splitLines = buffer.toString("utf-8").split("\n");
									if (splitLines.length > 1 && splitLines.at(-1) === "") splitLines.pop();
									totalFileLines = splitLines.length || 1;
									allLines = splitLines.slice(startLine, startLine + retainedLineLimit);
								}
								if (startLine >= totalFileLines) {
									throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
								}
								const selectedContent = allLines.join("\n");
								const userLimitedLines = limit === undefined ? undefined : allLines.length;
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									const firstLineSize = formatSize(Buffer.byteLength(allLines[0] ?? "", "utf-8"));
									const quotedPath = `'${path.replace(/'/g, "'\\''")}'`;
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${quotedPath} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
									const remaining = totalFileLines - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
