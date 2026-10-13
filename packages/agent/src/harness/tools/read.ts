import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool, ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "../utils/truncate.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "./image.ts";
import { resolveReadToolPath } from "./path-utils.ts";
import {
	getUnreadableContentReason,
	getUnreadableFileKindReason,
	getUnreadablePathReason,
	isPdfContent,
	isPdfPath,
	TEXT_SNIFF_BYTES,
} from "./text-file.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/** Files above this size are rejected: this tool buffers the whole file (the CLI streams instead). */
const MAX_READ_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Reject directories, special files, and oversized files before reading. `fileInfo` does not follow
 * symlinks, so a symlink is resolved first: a symlink to a FIFO or device must never be opened.
 */
async function getUnreadableFileReason(
	env: ExecutionEnv,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const info = getOrThrow(await env.fileInfo(absolutePath, signal));
	// A resolved symlink reports the target's kind and size, which is what a read would use.
	const target =
		info.kind === "symlink"
			? getOrThrow(await env.fileInfo(getOrThrow(await env.canonicalPath(absolutePath, signal)), signal))
			: info;

	const kindReason = getUnreadableFileKindReason(
		absolutePath,
		target.kind === "file" ? "file" : target.kind === "directory" ? "directory" : "other",
	);
	if (kindReason) return kindReason;

	if (target.size > MAX_READ_FILE_BYTES) {
		return `Cannot read ${absolutePath}: the file is ${formatSize(target.size)}, above the read tool's ${formatSize(MAX_READ_FILE_BYTES)} size limit. Use bash (for example \`head\`, \`sed -n\`, or \`rg\`) to inspect it.`;
	}

	return undefined;
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({ minimum: 1, multipleOf: 1, description: "Line number to start reading from (1-indexed)" }),
	),
	limit: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1, description: "Maximum number of lines to read" })),
	pages: Type.Optional(Type.String({ description: 'Page range for PDF files, for example "3", "1-5", or "10-"' })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export type ReadImageProcessorResult =
	| { ok: true; data: string; mimeType: string; hints: string[] }
	| { ok: false; message: string };

export type ReadImageProcessor = (
	bytes: Uint8Array,
	mimeType: string,
	options: { autoResizeImages: boolean },
) => Promise<ReadImageProcessorResult>;

/** Extracts model-facing text for a PDF; hosts without a PDF parser omit it. */
export type ReadPdfTextExtractor = (
	bytes: Uint8Array,
	pages: string | undefined,
	signal?: AbortSignal,
) => Promise<string>;

export interface ReadToolOptions {
	/** Whether an injected image processor should resize images. Default: true. */
	autoResizeImages?: boolean;
	/** Optional image conversion/resizing implementation. */
	imageProcessor?: ReadImageProcessor;
	/** Optional PDF text extraction implementation. PDFs are reported as unsupported without it. */
	pdfTextExtractor?: ReadPdfTextExtractor;
}

export function createReadTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: ReadToolOptions,
): AgentHarnessTool<TContext, typeof readSchema, ReadToolDetails | undefined> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files, images (jpg, png, gif, webp, bmp), and PDFs. Images are sent as attachments; PDFs are converted to text. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Files larger than ${MAX_READ_FILE_BYTES / (1024 * 1024)}MB are rejected. Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit, pages }, signal, _onUpdate, { env }) {
			const absolutePath = await resolveReadToolPath(env, path, signal);
			const pathReason = getUnreadablePathReason(absolutePath);
			if (pathReason) throw new Error(pathReason);
			const fileReason = await getUnreadableFileReason(env, absolutePath, signal);
			if (fileReason) throw new Error(fileReason);
			const bytes = getOrThrow(await env.readBinaryFile(absolutePath, signal));
			const mimeType = detectSupportedImageMimeType(bytes);
			if (mimeType) {
				if (options?.imageProcessor) {
					const processed = await options.imageProcessor(bytes, mimeType, {
						autoResizeImages: options.autoResizeImages ?? true,
					});
					if (!processed.ok) {
						return {
							content: [{ type: "text", text: `Read image file [${mimeType}]\n${processed.message}` }],
							details: undefined,
						};
					}
					const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
					return {
						content: [
							{ type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
							{ type: "image", data: processed.data, mimeType: processed.mimeType },
						] satisfies Array<TextContent | ImageContent>,
						details: undefined,
					};
				}
				if (mimeType === "image/bmp") {
					return {
						content: [
							{
								type: "text",
								text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
							},
						],
						details: undefined,
					};
				}
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: encodeBase64(bytes), mimeType },
					] satisfies Array<TextContent | ImageContent>,
					details: undefined,
				};
			}

			const contentReason = getUnreadableContentReason(absolutePath, bytes.subarray(0, TEXT_SNIFF_BYTES));

			if (isPdfPath(absolutePath) && isPdfContent(bytes.subarray(0, 1024))) {
				const extractor = options?.pdfTextExtractor;
				if (!extractor) {
					throw new Error(`Cannot read ${absolutePath}: PDF support is not available in this environment.`);
				}
				return {
					content: [{ type: "text", text: await extractor(bytes, pages, signal) }],
					details: undefined,
				};
			}

			if (contentReason) throw new Error(contentReason);

			const textContent = new TextDecoder().decode(bytes);
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset === undefined ? 0 : Math.max(0, offset - 1);
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(new TextEncoder().encode(allLines[startLine]).byteLength);
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
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
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
