import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { MAX_PDF_RENDER_PAGES_PER_READ } from "./pdf-render.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

/** Maximum number of pages extracted by one read, matching the limit models are told about. */
export const MAX_PDF_PAGES_PER_READ = 50;

/** Refuse oversized PDFs before handing bytes to the parser, which would allocate far more. */
export const MAX_PDF_BYTES = 64 * 1024 * 1024;

export interface PdfPageText {
	pageNumber: number;
	text: string;
}

export interface PdfExtractedPage extends PdfPageText {
	/** Page width in PDF points, after the page's rotation. */
	width: number;
	/** Page height in PDF points, after the page's rotation. */
	height: number;
}

export type PdfTextExtraction =
	| { ok: true; totalPages: number; pages: PdfExtractedPage[]; firstPage: number; lastPage: number }
	| { ok: false; message: string };

export interface PdfReadResult {
	/** Model-facing text including the page header, page markers, and any truncation notice. */
	text: string;
	totalPages: number;
	firstPage: number;
	lastPage: number;
	/** Number of pages whose content is present in `text`. */
	includedPages: number;
}

const PAGE_RANGE_PATTERN = /^(\d+)(?:-(\d*))?$/;

/**
 * Parse a model-supplied page range: `"3"`, `"1-5"`, or `"10-"` (page 10 through the end).
 * Returns undefined for anything else, including zero, negative, and reversed ranges.
 */
export function parsePdfPageRange(spec: string): { firstPage: number; lastPage: number } | undefined {
	const match = PAGE_RANGE_PATTERN.exec(spec.trim());
	if (!match) return undefined;

	const firstPage = Number(match[1]);
	if (!Number.isSafeInteger(firstPage) || firstPage < 1) return undefined;
	if (match[2] === undefined) return { firstPage, lastPage: firstPage };
	if (match[2] === "") return { firstPage, lastPage: Number.POSITIVE_INFINITY };

	const lastPage = Number(match[2]);
	if (!Number.isSafeInteger(lastPage) || lastPage < firstPage) return undefined;
	return { firstPage, lastPage };
}

/**
 * Extract text from the requested pages of a PDF. Encrypted, corrupt, and oversized documents
 * return `ok: false` with a message instead of throwing, so the read tool can report them.
 * Abort signals are honored between pages; pdf.js itself has no cancellation support.
 */
export async function extractPdfText(
	bytes: Uint8Array,
	options: { pages?: string; signal?: AbortSignal; maxPages?: number } = {},
): Promise<PdfTextExtraction> {
	const maxPages = options.maxPages ?? MAX_PDF_PAGES_PER_READ;
	if (bytes.byteLength > MAX_PDF_BYTES) {
		return {
			ok: false,
			message: `PDF is ${formatSize(bytes.byteLength)}, above the read tool's ${formatSize(MAX_PDF_BYTES)} PDF limit.`,
		};
	}

	let requested = { firstPage: 1, lastPage: Number.POSITIVE_INFINITY };
	if (options.pages !== undefined) {
		const parsed = parsePdfPageRange(options.pages);
		if (!parsed) {
			return {
				ok: false,
				message: `Invalid pages value "${options.pages}". Use "3", "1-5", or "10-" for an open-ended range (pages are 1-indexed).`,
			};
		}
		if (Number.isFinite(parsed.lastPage) && parsed.lastPage - parsed.firstPage + 1 > maxPages) {
			return {
				ok: false,
				message: `Page range "${options.pages}" exceeds the maximum of ${maxPages} pages per read.`,
			};
		}
		requested = parsed;
	}

	const signal = options.signal;
	const throwIfAborted = (): void => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};
	throwIfAborted();

	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		const pdfjs = await getResolvedPDFJS();
		pdf = await getDocumentProxy(toPdfBytes(bytes), { verbosity: pdfjs.VerbosityLevel.ERRORS });
	} catch (error) {
		throwIfAborted();
		return { ok: false, message: describePdfError(error) };
	}

	try {
		const totalPages = pdf.numPages;
		if (totalPages < 1) return { ok: false, message: "PDF contains no pages." };
		if (requested.firstPage > totalPages) {
			return {
				ok: false,
				message: `PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}; page ${requested.firstPage} does not exist.`,
			};
		}

		const firstPage = requested.firstPage;
		const lastPage = Math.min(requested.lastPage, totalPages);
		const pageCount = Math.min(lastPage - firstPage + 1, maxPages);
		const pages: PdfExtractedPage[] = [];

		for (let pageNumber = firstPage; pageNumber < firstPage + pageCount; pageNumber++) {
			throwIfAborted();
			const page = await pdf.getPage(pageNumber);
			const textContent = await page.getTextContent();
			const { width, height } = page.getViewport({ scale: 1 });
			pages.push({ pageNumber, text: normalizePageText(textContent.items), width, height });
		}

		return { ok: true, totalPages, pages, firstPage, lastPage: firstPage + pageCount - 1 };
	} catch (error) {
		throwIfAborted();
		return { ok: false, message: describePdfError(error) };
	} finally {
		// Releases the pdf.js worker and its WASM heap; without it a failed or aborted
		// extraction leaks the document for the life of the process.
		await pdf.loadingTask.destroy().catch(() => {});
	}
}

/**
 * Adapter used by the read tool and by hosts that inject PDF reading into their own read tool:
 * extracts the requested pages and returns the model-facing text, throwing on refusal.
 */
export async function extractPdfReadText(
	bytes: Uint8Array,
	pages: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const extraction = await extractPdfText(bytes, { pages, signal });
	if (!extraction.ok) throw new Error(extraction.message);
	return formatPdfText(extraction).text;
}

/**
 * Format extracted pages for the model, honoring the read tool's line and byte limits.
 * Pages are added whole; the first page is truncated in place when it alone exceeds a limit.
 *
 * `render` tells the text how page images relate to it: `"available"` when the caller's read
 * tool accepts `render=true`, `"rendered"` when the same pages are attached as images.
 */
export function formatPdfText(
	result: Omit<Extract<PdfTextExtraction, { ok: true }>, "pages"> & { pages: PdfPageText[] },
	options: { maxLines?: number; maxBytes?: number; render?: "available" | "rendered" } = {},
): PdfReadResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const { totalPages, pages, firstPage, lastPage } = result;

	const renderHint =
		options.render === "available" ? " (render=true attaches page images for figures and layout)" : "";
	const header = `PDF (${totalPages} page${totalPages === 1 ? "" : "s"}). Text of pages ${firstPage}-${lastPage}${renderHint}:`;

	if (pages.every((page) => page.text.length === 0)) {
		return {
			text: `${header}\nNo extractable text in those pages. ${
				options.render === "rendered"
					? "The rendered page images follow."
					: options.render === "available"
						? "The pages likely hold scanned images or vector graphics; use render=true to view them as images."
						: "The PDF likely contains scanned images, which the read tool cannot read."
			}`,
			totalPages,
			firstPage,
			lastPage,
			includedPages: 0,
		};
	}

	const sections = pages.map((page) => ({
		pageNumber: page.pageNumber,
		lines: page.text.length === 0 ? ["(no extractable text on this page)"] : page.text.split("\n"),
	}));

	const included: typeof sections = [];
	// The header, the blank line, and the page marker are budgeted too, so the rendered text
	// stays within the limits this function promises.
	let lineCount = 1;
	let byteCount = Buffer.byteLength(header, "utf8");
	let firstPageTruncated = false;
	for (const section of sections) {
		const marker = `\n\n--- page ${section.pageNumber} ---`;
		const markerBytes = Buffer.byteLength(marker, "utf8");
		const sectionBytes = Buffer.byteLength(section.lines.join("\n"), "utf8");
		if (included.length === 0) {
			lineCount += 2 + section.lines.length;
			firstPageTruncated = lineCount > maxLines || byteCount + markerBytes + sectionBytes > maxBytes;
		} else {
			if (lineCount + 2 + section.lines.length > maxLines || byteCount + markerBytes + sectionBytes > maxBytes)
				break;
			lineCount += 2 + section.lines.length;
		}
		byteCount += markerBytes + sectionBytes;
		included.push(section);
	}

	const body: string[] = [header];
	for (let index = 0; index < included.length; index++) {
		const section = included[index];
		body.push("", `--- page ${section.pageNumber} ---`);
		if (index === 0 && firstPageTruncated) {
			// `body` already holds the header, the blank line, and the page marker, and a
			// truncation notice costs two more lines. Truncate against what is left so the
			// rendered text stays inside the limits this function promises.
			const lineNotice = `[Page ${section.pageNumber} truncated at the ${maxLines}-line limit.]`;
			const byteNotice = `[Page ${section.pageNumber} truncated at the ${formatSize(maxBytes)} limit.]`;
			const prefixBytes = Buffer.byteLength(body.join("\n"), "utf8");
			const noticeBytes = Math.max(Buffer.byteLength(lineNotice, "utf8"), Buffer.byteLength(byteNotice, "utf8"));
			const truncated = truncateHead(section.lines.join("\n"), {
				maxLines: Math.max(1, maxLines - body.length - 2),
				maxBytes: Math.max(1, maxBytes - prefixBytes - noticeBytes - 1),
			});
			body.push(truncated.content);
			if (truncated.truncated) {
				const reason =
					truncated.truncatedBy === "lines" ? `${maxLines}-line limit` : `${formatSize(maxBytes)} limit`;
				body.push("", `[Page ${section.pageNumber} truncated at the ${reason}.]`);
			}
		} else {
			body.push(...section.lines);
		}
	}

	const includedLast = included[included.length - 1]?.pageNumber ?? firstPage;
	if (includedLast < totalPages || included.length < sections.length) {
		const rendered = options.render === "rendered";
		const nextEnd = Math.min(
			totalPages,
			includedLast + (rendered ? MAX_PDF_RENDER_PAGES_PER_READ : MAX_PDF_PAGES_PER_READ),
		);
		body.push(
			"",
			`[Showing ${rendered ? "text of " : ""}pages ${firstPage}-${includedLast} of ${totalPages}. Use pages="${includedLast + 1}-${nextEnd}"${rendered ? " with render=true" : ""} to continue.]`,
		);
	}

	return { text: body.join("\n"), totalPages, firstPage, lastPage, includedPages: included.length };
}

function normalizePageText(items: readonly unknown[]): string {
	const parts: string[] = [];
	for (const item of items) {
		const textItem = item as { str?: unknown; hasEOL?: unknown };
		if (typeof textItem.str !== "string") continue;
		parts.push(textItem.str + (textItem.hasEOL === true ? "\n" : ""));
	}
	return parts
		.join("")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * pdf.js rejects Node Buffers with "Please provide binary data as `Uint8Array`, rather than
 * `Buffer`". Buffer is a Uint8Array subclass, so copy it into a plain view before handing it over.
 */
function toPdfBytes(bytes: Uint8Array): Uint8Array {
	return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes);
}

function describePdfError(error: unknown): string {
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (/password/i.test(name) || /password/i.test(message)) {
		return "PDF is password protected and cannot be read.";
	}
	return `Could not read the PDF: ${message || "unknown parser error"}`;
}
