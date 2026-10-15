/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

function exitWithReadError(path: string, error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red(`Error: Could not read file ${path}: ${message}`));
	process.exit(1);
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const stats = await stat(absolutePath);
		if (stats.isDirectory()) {
			console.error(chalk.red(`Error: Not a file: ${absolutePath} is a directory`));
			process.exit(1);
		}

		// Check if file is empty. Pipes report no size; they are checked once read.
		if (!stats.isFIFO() && stats.size === 0) {
			// Skip empty files
			continue;
		}

		// A pipe (e.g. `@<(cmd)`) cannot be read at an offset, so read it once in full and detect
		// the type from that buffer.
		let streamed: Buffer | undefined;
		let mimeType: string | null;
		try {
			streamed = stats.isFIFO() ? await readFile(absolutePath) : undefined;
			mimeType = streamed
				? detectSupportedImageMimeType(streamed)
				: await detectSupportedImageMimeTypeFromFile(absolutePath);
		} catch (error: unknown) {
			exitWithReadError(absolutePath, error);
		}
		if (streamed?.length === 0) {
			continue;
		}

		if (mimeType) {
			// Handle image file
			const content = streamed ?? (await readFile(absolutePath));
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				const content = stripBom(streamed ? streamed.toString("utf-8") : await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				exitWithReadError(absolutePath, error);
			}
		}
	}

	return { text, images };
}
