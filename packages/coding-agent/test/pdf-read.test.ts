import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	extractPdfText,
	formatPdfText,
	MAX_PDF_PAGES_PER_READ,
	parsePdfPageRange,
} from "../src/core/tools/pdf-read.ts";
import { createReadTool } from "../src/core/tools/read.ts";

/** Build a minimal single-font PDF whose pages contain the given texts. */
function buildPdf(pageTexts: string[]): Buffer {
	const objects: string[] = [];
	const pageObjectNumbers = pageTexts.map((_, index) => 3 + index * 2);
	const fontObjectNumber = 3 + pageTexts.length * 2;

	objects.push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj");
	objects.push(
		`2 0 obj<</Type/Pages/Kids[${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}]/Count ${pageTexts.length}>>endobj`,
	);

	pageTexts.forEach((text, index) => {
		const pageNumber = pageObjectNumbers[index];
		const contentNumber = pageNumber + 1;
		const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([\\()])/g, "\\$1")}) Tj ET`;
		objects.push(
			`${pageNumber} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNumber} 0 R/Resources<</Font<</F1 ${fontObjectNumber} 0 R>>>>>>endobj`,
		);
		objects.push(`${contentNumber} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj`);
	});

	objects.push(`${fontObjectNumber} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);
	return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, "utf8");
}

/** Build a minimal encrypted PDF (standard security handler, RC4 40-bit, empty user password). */
function buildEncryptedPdf(): Buffer {
	const objects = [
		"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj",
		"4 0 obj<</Length 0>>stream\n\nendstream\nendobj",
		"5 0 obj<</Filter/Standard/V 1/R 2/O <000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f> /U <000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f> /P -44 /Length 40>>endobj",
	];
	return Buffer.from(
		`%PDF-1.4\n${objects.join("\n")}\ntrailer<</Root 1 0 R/Encrypt 5 0 R/ID[<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>]>>\n%%EOF\n`,
		"utf8",
	);
}

const THREE_PAGE_PDF = buildPdf(["First page report", "Second page details", "Third page summary"]);

describe("parsePdfPageRange", () => {
	it("parses single pages, ranges, and open-ended ranges", () => {
		expect(parsePdfPageRange("3")).toEqual({ firstPage: 3, lastPage: 3 });
		expect(parsePdfPageRange(" 1-5 ")).toEqual({ firstPage: 1, lastPage: 5 });
		expect(parsePdfPageRange("10-")).toEqual({ firstPage: 10, lastPage: Number.POSITIVE_INFINITY });
		expect(parsePdfPageRange("2-2")).toEqual({ firstPage: 2, lastPage: 2 });
	});

	it("rejects malformed, zero, negative, and reversed ranges", () => {
		for (const spec of ["", "0", "5-2", "abc", "1-2-3", "-3", "1.5", "1 2", "Infinity"]) {
			expect(parsePdfPageRange(spec), spec).toBeUndefined();
		}
	});
});

describe("extractPdfText", () => {
	it("extracts every page by default", async () => {
		const result = await extractPdfText(THREE_PAGE_PDF);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.totalPages).toBe(3);
		expect(result.pages.map((page) => page.text)).toEqual([
			"First page report",
			"Second page details",
			"Third page summary",
		]);
		expect(result.firstPage).toBe(1);
		expect(result.lastPage).toBe(3);
	});

	it("extracts a single page and an inclusive range", async () => {
		const single = await extractPdfText(THREE_PAGE_PDF, { pages: "2" });
		expect(single.ok && single.pages).toEqual([{ pageNumber: 2, text: "Second page details" }]);

		const range = await extractPdfText(THREE_PAGE_PDF, { pages: "2-3" });
		expect(range.ok && range.pages.map((page) => page.pageNumber)).toEqual([2, 3]);
	});

	it("clamps an open-ended range to the document", async () => {
		const result = await extractPdfText(THREE_PAGE_PDF, { pages: "2-" });
		expect(result.ok && result.pages.map((page) => page.pageNumber)).toEqual([2, 3]);
	});

	it("reports invalid page ranges instead of throwing", async () => {
		const result = await extractPdfText(THREE_PAGE_PDF, { pages: "nope" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("Invalid pages value");
	});

	it("refuses ranges beyond the per-read page cap", async () => {
		const result = await extractPdfText(THREE_PAGE_PDF, { pages: `1-${MAX_PDF_PAGES_PER_READ + 1}` });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain(String(MAX_PDF_PAGES_PER_READ));
	});

	it("reports a page beyond the end of the document instead of returning the last page", async () => {
		const result = await extractPdfText(THREE_PAGE_PDF, { pages: "99" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("page 99 does not exist");
	});

	it("reports unparseable bytes instead of throwing", async () => {
		const result = await extractPdfText(Buffer.from("%PDF-1.4\nthis is not a pdf body\n%%EOF\n"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("Could not read the PDF");
	});

	it("reports password-protected PDFs", async () => {
		const result = await extractPdfText(buildEncryptedPdf());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe("PDF is password protected and cannot be read.");
	});

	it("honors an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(extractPdfText(THREE_PAGE_PDF, { signal: controller.signal })).rejects.toThrow("Operation aborted");
	});
});

describe("formatPdfText", () => {
	it("marks pages and reports the document length", () => {
		const text = formatPdfText({
			ok: true,
			totalPages: 3,
			pages: [
				{ pageNumber: 1, text: "one" },
				{ pageNumber: 2, text: "two" },
			],
			firstPage: 1,
			lastPage: 2,
		});
		expect(text.text).toContain("PDF (3 pages). Text of pages 1-2:");
		expect(text.text).toContain("--- page 1 ---");
		expect(text.text).toContain("--- page 2 ---");
		expect(text.includedPages).toBe(2);
		expect(text.text).toContain('[Showing pages 1-2 of 3. Use pages="3-3" to continue.]');
	});

	it("reports scanned PDFs with no extractable text", () => {
		const text = formatPdfText({
			ok: true,
			totalPages: 2,
			pages: [
				{ pageNumber: 1, text: "" },
				{ pageNumber: 2, text: "" },
			],
			firstPage: 1,
			lastPage: 2,
		});
		expect(text.includedPages).toBe(0);
		expect(text.text).toContain("No extractable text");
	});

	it("stops at the output limits and names the next page range", () => {
		const text = formatPdfText(
			{
				ok: true,
				totalPages: 5,
				pages: [
					{ pageNumber: 1, text: "alpha\nbeta" },
					{ pageNumber: 2, text: "gamma\ndelta" },
					{ pageNumber: 3, text: "epsilon" },
				],
				firstPage: 1,
				lastPage: 3,
			},
			{ maxLines: 3, maxBytes: 1024 },
		);
		expect(text.includedPages).toBe(1);
		expect(text.text).toContain("alpha");
		expect(text.text).not.toContain("gamma");
		expect(text.text).toContain('[Showing pages 1-1 of 5. Use pages="2-5" to continue.]');
	});

	it("truncates a first page that exceeds the limit on its own", () => {
		const text = formatPdfText(
			{
				ok: true,
				totalPages: 2,
				pages: [
					{ pageNumber: 1, text: "line one\nline two\nline three" },
					{ pageNumber: 2, text: "second" },
				],
				firstPage: 1,
				lastPage: 2,
			},
			{ maxLines: 2, maxBytes: 1024 },
		);
		expect(text.text).toContain("line one");
		expect(text.text).toContain("[Page 1 truncated at the 2-line limit.]");
		expect(text.includedPages).toBe(1);
	});

	it("keeps the rendered text within the line and byte budgets it is given", () => {
		const pages = Array.from({ length: 50 }, (_, index) => ({
			pageNumber: index + 1,
			text: Array.from({ length: 40 }, (__, line) => `page ${index + 1} line ${line + 1}`).join("\n"),
		}));
		const formatted = formatPdfText(
			{ ok: true, totalPages: 50, pages, firstPage: 1, lastPage: 50 },
			{ maxLines: 2000, maxBytes: 50 * 1024 },
		);

		// The trailing continuation notice is extra, matching the text path's convention.
		const body = formatted.text.split("\n\n[Showing pages")[0] ?? "";
		expect(body.split("\n").length).toBeLessThanOrEqual(2000);
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(formatted.includedPages).toBeGreaterThan(0);
		expect(formatted.includedPages).toBeLessThan(50);
	});

	it("marks empty pages inside an otherwise extractable document", () => {
		const text = formatPdfText({
			ok: true,
			totalPages: 2,
			pages: [
				{ pageNumber: 1, text: "" },
				{ pageNumber: 2, text: "visible" },
			],
			firstPage: 1,
			lastPage: 2,
		});
		expect(text.text).toContain("(no extractable text on this page)");
		expect(text.includedPages).toBe(2);
	});
});

describe("pdf.js on a runtime without Promise.try", () => {
	it("loads and extracts text after the Node 24 helpers are removed", () => {
		// pie supports Node 22, which lacks Promise.try, Promise.withResolvers,
		// Map.prototype.getOrInsertComputed, Uint8Array.prototype.toHex, and Math.sumPrecise.
		// pdf.js installs its own polyfills at load time; this runs in a child process so the
		// cleared globals cannot affect other tests.
		const script = [
			"Promise.try = undefined;",
			"Promise.withResolvers = undefined;",
			"Map.prototype.getOrInsertComputed = undefined;",
			"Uint8Array.prototype.toHex = undefined;",
			"Math.sumPrecise = undefined;",
			'const { getDocumentProxy, getResolvedPDFJS } = await import("unpdf");',
			"const pdfjs = await getResolvedPDFJS();",
			"const bytes = new TextEncoder().encode(process.env.PROBE_PDF_TEXT);",
			"const pdf = await getDocumentProxy(bytes, { verbosity: pdfjs.VerbosityLevel.ERRORS });",
			"const page = await pdf.getPage(1);",
			"const content = await page.getTextContent();",
			"console.log(JSON.stringify({",
			"  text: content.items.map((item) => item.str ?? '').join(' '),",
			"  polyfilled: { promiseTry: typeof Promise.try, withResolvers: typeof Promise.withResolvers },",
			"}));",
			"await pdf.loadingTask.destroy();",
		].join("\n");

		const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: fileURLToPath(new URL("../../..", import.meta.url)),
			encoding: "utf8",
			env: { ...process.env, PROBE_PDF_TEXT: buildPdf(["Promise.try probe"]).toString("utf8") },
		});

		const parsed = JSON.parse(stdout.trim()) as {
			text: string;
			polyfilled: { promiseTry: string; withResolvers: string };
		};
		expect(parsed.text).toContain("Promise.try probe");
		expect(parsed.polyfilled.promiseTry).toBe("function");
		expect(parsed.polyfilled.withResolvers).toBe("function");
	});
});

describe("read tool with PDFs", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "read-pdf-"));
		await writeFile(join(dir, "report.pdf"), THREE_PAGE_PDF);
		await writeFile(join(dir, "notes.pdf"), "just text, wrong extension\n");
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads a whole PDF as text", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("pdf-1", { path: "report.pdf" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("PDF (3 pages). Text of pages 1-3:");
		expect(text).toContain("Second page details");
	});

	it("reads a page range", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("pdf-2", { path: "report.pdf", pages: "3" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Third page summary");
		expect(text).not.toContain("First page report");
	});

	it("reads a .pdf file that is not PDF content as text", async () => {
		const read = createReadTool(dir);
		const result = await read.execute("pdf-3", { path: "notes.pdf" });
		expect((result.content[0] as { text: string }).text).toContain("just text, wrong extension");
	});
});
