import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Maximum pages rendered to images by one read. Each page becomes an image attachment of up to
 * ~1.6k tokens on vision models, so this keeps a rendered read in the same budget as a long
 * text read while covering a typical figure set or a few manuscript pages.
 */
export const MAX_PDF_RENDER_PAGES_PER_READ = 10;

/**
 * Long side of a rendered page in pixels. The read tool's image pipeline caps inline images at
 * 2000px per side, so rendering larger only spends time on detail the resize step discards.
 */
const RENDER_LONG_SIDE_PX = 2000;

/** Points per inch in PDF user space; Ghostscript takes a DPI, so sizes in points convert through it. */
const POINTS_PER_INCH = 72;

/** Upper bound on one renderer process, so a pathological PDF cannot stall the read forever. */
const RENDER_TIMEOUT_MS = 120_000;

/** Keep only the tail of renderer stderr for error messages. */
const MAX_STDERR_CHARS = 4_000;

export interface PdfPageToRender {
	pageNumber: number;
	/** Page width in PDF points after rotation. */
	width: number;
	/** Page height in PDF points after rotation. */
	height: number;
}

export interface RenderedPdfPage {
	pageNumber: number;
	png: Buffer;
}

export type PdfRenderResult = { ok: true; pages: RenderedPdfPage[] } | { ok: false; message: string };

type RunResult = { kind: "ok" } | { kind: "missing" } | { kind: "failed"; message: string };

const NO_RENDERER_MESSAGE =
	"Rendering PDF pages needs Ghostscript or poppler's pdftoppm on PATH (for example `brew install ghostscript` or `apt install poppler-utils`).";

function runRenderer(command: string, args: string[], signal: AbortSignal | undefined): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		const kill = () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		};
		const onAbort = () => {
			kill();
			settle(() => reject(new Error("Operation aborted")));
		};
		const timer = setTimeout(() => {
			kill();
			settle(() =>
				resolve({ kind: "failed", message: `${command} did not finish within ${RENDER_TIMEOUT_MS / 1000}s` }),
			);
		}, RENDER_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			settle(() =>
				error.code === "ENOENT"
					? resolve({ kind: "missing" })
					: resolve({ kind: "failed", message: `${command} failed to start: ${error.message}` }),
			);
		});
		child.on("close", (code, killSignal) => {
			settle(() => {
				if (code === 0) resolve({ kind: "ok" });
				else {
					const status = code === null ? `signal ${killSignal}` : `exit code ${code}`;
					const detail = stderr.trim();
					resolve({ kind: "failed", message: `${command} failed with ${status}${detail ? `: ${detail}` : ""}` });
				}
			});
		});
	});
}

/** Map pdftoppm output names (`page-07.png`, zero-padded to the document's page-count width) to page numbers. */
async function collectPdftoppmPages(outputDir: string, prefix: string): Promise<RenderedPdfPage[]> {
	const pages: RenderedPdfPage[] = [];
	const pattern = new RegExp(`^${prefix}-(\\d+)\\.png$`);
	for (const name of await readdir(outputDir)) {
		const match = pattern.exec(name);
		if (!match) continue;
		pages.push({ pageNumber: Number(match[1]), png: await readFile(join(outputDir, name)) });
	}
	return pages.sort((a, b) => a.pageNumber - b.pageNumber);
}

async function renderWithPdftoppm(
	pdfPath: string,
	outputDir: string,
	pages: PdfPageToRender[],
	signal: AbortSignal | undefined,
): Promise<RunResult & { pages?: RenderedPdfPage[] }> {
	const first = pages[0]!.pageNumber;
	const last = pages[pages.length - 1]!.pageNumber;
	const prefix = "page";
	const result = await runRenderer(
		"pdftoppm",
		[
			"-png",
			"-cropbox",
			"-f",
			String(first),
			"-l",
			String(last),
			"-scale-to",
			String(RENDER_LONG_SIDE_PX),
			pdfPath,
			join(outputDir, prefix),
		],
		signal,
	);
	if (result.kind !== "ok") return result;
	return { kind: "ok", pages: await collectPdftoppmPages(outputDir, prefix) };
}

async function renderWithGhostscript(
	pdfPath: string,
	outputDir: string,
	pages: PdfPageToRender[],
	signal: AbortSignal | undefined,
): Promise<RunResult & { pages?: RenderedPdfPage[] }> {
	const command = process.platform === "win32" ? "gswin64c" : "gs";
	const rendered: RenderedPdfPage[] = [];
	// One process per page: Ghostscript takes a single resolution per run, and pages can differ in size.
	for (const page of pages) {
		const longSide = Math.max(page.width, page.height);
		// Floor so the long side lands on, not just past, the cap; one extra pixel forces a full resize.
		const dpi =
			longSide > 0 ? Math.floor(((RENDER_LONG_SIDE_PX * POINTS_PER_INCH) / longSide) * 100) / 100 : POINTS_PER_INCH;
		const outputPath = join(outputDir, `gs-${page.pageNumber}.png`);
		const result = await runRenderer(
			command,
			[
				"-dSAFER",
				"-dBATCH",
				"-dNOPAUSE",
				"-dQUIET",
				"-dUseCropBox",
				"-sDEVICE=png16m",
				"-dTextAlphaBits=4",
				"-dGraphicsAlphaBits=4",
				`-r${dpi}`,
				`-dFirstPage=${page.pageNumber}`,
				`-dLastPage=${page.pageNumber}`,
				`-sOutputFile=${outputPath}`,
				pdfPath,
			],
			signal,
		);
		if (result.kind !== "ok") return result;
		rendered.push({ pageNumber: page.pageNumber, png: await readFile(outputPath) });
	}
	return { kind: "ok", pages: rendered };
}

/**
 * Render consecutive PDF pages to PNG with Ghostscript, falling back to poppler's `pdftoppm`.
 * Ghostscript is preferred because it renders the same output with about a third of the CPU time
 * and half the PNG size. Pure-JS rendering would need a native canvas binding, while these tools
 * already ship with TeX distributions and most Linux systems. The bytes are written to a private temporary directory, so this
 * works for every read backend, and the directory is always removed.
 */
export async function renderPdfPages(
	bytes: Uint8Array,
	pages: PdfPageToRender[],
	signal?: AbortSignal,
): Promise<PdfRenderResult> {
	if (pages.length === 0) return { ok: true, pages: [] };
	if (pages.length > MAX_PDF_RENDER_PAGES_PER_READ) {
		return { ok: false, message: `Cannot render more than ${MAX_PDF_RENDER_PAGES_PER_READ} pages per read.` };
	}
	for (let index = 1; index < pages.length; index++) {
		if (pages[index]!.pageNumber !== pages[index - 1]!.pageNumber + 1) {
			return { ok: false, message: "Rendered PDF pages must be consecutive." };
		}
	}
	signal?.throwIfAborted();

	const workDir = await mkdtemp(join(tmpdir(), "pie-pdf-render-"));
	try {
		const pdfPath = join(workDir, "input.pdf");
		await writeFile(pdfPath, bytes, { mode: 0o600 });

		const failures: string[] = [];
		for (const renderer of [renderWithGhostscript, renderWithPdftoppm]) {
			const result = await renderer(pdfPath, workDir, pages, signal);
			if (result.kind === "missing") continue;
			if (result.kind === "failed") {
				failures.push(result.message);
				continue;
			}
			const rendered = result.pages ?? [];
			const expected = pages.map((page) => page.pageNumber).join(",");
			const actual = rendered.map((page) => page.pageNumber).join(",");
			if (expected !== actual) {
				failures.push(`renderer produced pages [${actual}] instead of [${expected}]`);
				continue;
			}
			return { ok: true, pages: rendered };
		}
		if (failures.length === 0) return { ok: false, message: NO_RENDERER_MESSAGE };
		return { ok: false, message: `Could not render the PDF pages: ${failures.join("; ")}` };
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
