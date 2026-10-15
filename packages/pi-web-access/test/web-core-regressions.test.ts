import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { parseHTML } from "linkedom";
import { sanitizeInlineDataUris } from "../data-uri-sanitize.ts";
import { discoverDeclaredWebLinks } from "../declared-web-links.ts";
import { extractRSCContent } from "../rsc-extract.ts";
import { isYouTubeURL } from "../youtube-extract.ts";
import { normalizeFetchContentParams } from "../fetch-params.ts";
import { findContent } from "../content-find.ts";
import { clearResults, getAllResults, getResult, restoreFromSession, storeFetchedContentResult } from "../storage.ts";
import { createCuratorResultIndexAllocator, startCuratorServer } from "../curator-server.ts";
import { clearPdfArtifacts, extractPDFToMarkdown } from "../pdf-extract.ts";
import { parseGitHubUrl, resolveGitHubUrlInfo } from "../github-extract.ts";
import { extractGitHubIssuePr } from "../github-issue-pr.ts";
import { runWithProxy } from "../utils.ts";

const temporaryPaths: string[] = [];
const originalPath = process.env.PATH;
const originalAgentDir = process.env.PIE_CODING_AGENT_DIR;

function temporaryDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	temporaryPaths.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	clearResults();
	clearPdfArtifacts();
	process.env.PATH = originalPath;
	if (originalAgentDir === undefined) delete process.env.PIE_CODING_AGENT_DIR;
	else process.env.PIE_CODING_AGENT_DIR = originalAgentDir;
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("URL and parameter normalization", () => {
	it("classifies YouTube URLs from the parsed host and path only", () => {
		expect(isYouTubeURL("https://youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ isYouTube: true, videoId: "dQw4w9WgXcQ" });
		expect(isYouTubeURL("https://youtu.be/dQw4w9WgXcQ?t=4")).toEqual({ isYouTube: true, videoId: "dQw4w9WgXcQ" });
		expect(isYouTubeURL("https://example.test/page?ref=youtu.be/dQw4w9WgXcQ")).toEqual({ isYouTube: false, videoId: null });
		expect(isYouTubeURL("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toEqual({ isYouTube: false, videoId: null });
		expect(isYouTubeURL("https://youtube.com/playlist?list=dQw4w9WgXcQ")).toEqual({ isYouTube: false, videoId: null });
	});

	it("preserves an explicit single-frame request", () => {
		expect(normalizeFetchContentParams({ url: "/tmp/video.mp4", frames: 1 }).options.frames).toBe(1);
	});
});

describe("content finding", () => {
	it("reuses case folding and retains Unicode source offsets", () => {
		const text = `${"a".repeat(450_000)} İstanbul τέλος ${"b".repeat(100)}`;
		const startedOne = performance.now();
		const one = findContent(text, ["İSTANBUL"], "case-insensitive");
		const oneElapsed = performance.now() - startedOne;
		const startedMany = performance.now();
		const many = findContent(text, ["İSTANBUL", "missing1", "missing2", "missing3", "missing4", "missing5", "missing6", "missing7"], "case-insensitive");
		const manyElapsed = performance.now() - startedMany;
		expect(one.matchCount).toBe(1);
		expect(one.text).toContain("İstanbul τέλος");
		expect(many.matchCount).toBe(1);
		expect(manyElapsed).toBeLessThan(Math.max(oneElapsed * 4, 250));
	});

	it("folds case for a large text in one native pass", () => {
		// Folding per code point cost about 1 µs per character (2 s for this text).
		const text = `${"Lorem ipsum dolor sit amet. ".repeat(70_000)}The Needle sits here. ${"z".repeat(100)}`;
		const started = performance.now();
		const result = findContent(text, ["NEEDLE SITS"], "case-insensitive");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(result.matchCount).toBe(1);
		expect(result.text).toContain("The Needle sits here.");
	});

	it("splits fuzzy paragraphs at CRLF and whitespace-only blank lines", () => {
		const lf = "Alpha beta section.\n\nGamma delta section.\n\nEpsilon alpha again.";
		for (const text of [lf, lf.replace(/\n/g, "\r\n"), lf.replace(/\n\n/g, "\n \t\n")]) {
			expect(findContent(text, ["alpha gamma"], "fuzzy").matchCount).toBe(0);
			expect(findContent(text, ["alpha"], "fuzzy").matchCount).toBe(2);
		}
	});
});

describe("declared web links", () => {
	const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const page = document as unknown as Document;

	it("rejects a malformed quoted Link parameter in linear time", () => {
		// Trailing junk after a quoted backslash run used to backtrack with Fibonacci growth.
		const header = `<https://example.com/api>; rel="service-desc"; x="${"\\".repeat(36)}" y`;
		const started = performance.now();
		expect(discoverDeclaredWebLinks(page, header, "https://example.com/")).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("keeps escaped quotes and backslashes in quoted Link parameters", () => {
		const header = '<https://example.com/api>; rel="service-desc"; type="a \\"b\\" \\\\ c"';
		expect(discoverDeclaredWebLinks(page, header, "https://example.com/")).toEqual([
			{ url: "https://example.com/api", relations: ["service-desc"], type: 'a "b" \\ c' },
		]);
	});
});

describe("inline data URI sanitization", () => {
	it("leaves code and prose that only use a data: label untouched", () => {
		for (const text of [
			"function send(data: Buffer, encoding: BufferEncoding): void",
			"socket.on('message', (data: RawData, isBinary: boolean) => {})",
			"func upload(data: Data, to url: URL) async throws",
			"The response (data: the payload, meta: paging info) is JSON.",
			"if (url.startsWith('data:')) return;",
			"call(data:Buffer,encoding)",
		]) {
			expect(sanitizeInlineDataUris(text, "content")).toEqual({ text, omissions: [] });
		}
	});

	it("still replaces real and malformed inline data URIs", () => {
		const text = '![x](data:image/png;base64,iVBORw0KGgo=) <a href="data:,Hi">x</a> "data:image/png;base64" (data: Buffer, src="data:;base64,SGk=")';
		const result = sanitizeInlineDataUris(text, "content");
		expect(result.omissions.map(({ mimeType, encoding, decodeError }) => [mimeType, encoding, decodeError])).toEqual([
			["image/png", "base64", undefined],
			["text/plain", "percent-encoded", undefined],
			["image/png", "base64", "missing-comma"],
			["text/plain", "base64", undefined],
		]);
		expect(result.text).toContain('(data: Buffer, src="[pi-ext-web-access inline data URI omitted; ordinal=4;');
		expect(result.text).not.toContain("iVBORw0KGgo=");
	});
});

describe("RSC extraction", () => {
	/** A flight payload whose chunks each reference the next chunk twice. */
	function doublingChain(depth: number): string {
		const lines: string[] = [];
		for (let level = 0; level < depth; level++) {
			const next = (0x24 + level).toString(16);
			lines.push(`${(0x23 + level).toString(16)}:["$L${next}","$L${next}"]`);
		}
		lines.push(`${(0x23 + depth).toString(16)}:["$","p",null,{"children":"hello world, "}]`);
		const payload = JSON.stringify(lines.join("\n")).slice(1, -1);
		return `<html><head><title>x</title></head><body><script>self.__next_f.push([1,"${payload}"])</script></body></html>`;
	}

	it("bounds shared-reference expansion instead of doubling per level", () => {
		// Full rendering doubles with every level (3.7M chars at depth 18, 7.3M at 19).
		const shallow = extractRSCContent(doublingChain(18))?.content ?? "";
		const deep = extractRSCContent(doublingChain(19))?.content ?? "";
		expect(shallow).toMatch(/^hello world,\n\nhello world,/);
		expect(deep.length).toBeLessThanOrEqual(shallow.length * 1.1);
		expect(shallow.length).toBeLessThan(3_000_000);
	});
});

describe("fetch result storage", () => {
	it("retains metadata instead of all cached bodies and drops expired entries", () => {
		const configDir = temporaryDirectory("pie-storage-");
		process.env.PIE_CODING_AGENT_DIR = configDir;
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		for (let index = 0; index < 130; index++) {
			storeFetchedContentResult(`r${index}`, {
				id: `r${index}`,
				type: "fetch",
				timestamp: now,
				urls: [{ url: `https://example.test/${index}`, title: "x", content: "body", error: null }],
			});
		}
		expect(getAllResults()).toHaveLength(130);
		expect(getAllResults().some(result => "urls" in result)).toBe(false);
		expect(getResult("r0")).toMatchObject({ urls: [{ content: "", error: "Cached fetched content is missing or expired" }] });
		vi.mocked(Date.now).mockReturnValue(now + 60 * 60 * 1000);
		expect(getAllResults()).toHaveLength(0);
	}, 15_000);

	it("migrates legacy inline session fetches into the bounded cache", () => {
		const configDir = temporaryDirectory("pie-storage-restore-");
		process.env.PIE_CODING_AGENT_DIR = configDir;
		const now = Date.now();
		const entries = Array.from({ length: 130 }, (_, index) => ({
			type: "custom",
			customType: "web-search-results",
			data: {
				id: `legacy${index}`,
				type: "fetch",
				timestamp: now,
				urls: [{ url: `https://example.test/${index}`, title: "x", content: `body-${index}`, error: null }],
			},
		}));

		restoreFromSession({ sessionManager: { getBranch: () => entries } } as any);

		const restored = getAllResults();
		expect(restored).toHaveLength(130);
		expect(restored.some(result => "urls" in result)).toBe(false);
		expect(readdirSync(join(configDir, "web-search-cache")).filter(name => name.endsWith(".json"))).toHaveLength(128);
		expect(getResult("legacy129")).toMatchObject({ urls: [{ content: "body-129", error: null }] });
		expect(getResult("legacy0")).toMatchObject({ urls: [{ content: "", error: "Cached fetched content is missing or expired" }] });
	}, 15_000);
});

function curatorCallbacks(overrides: Record<string, unknown> = {}): any {
	return {
		onSubmit() {},
		onCancel() {},
		onProviderChange() {},
		onAddSearch: async () => [],
		onAddSearchResults() {},
		indexAllocator: createCuratorResultIndexAllocator(1),
		onSummarize: async () => ({ summary: "", meta: {} }),
		onRewriteQuery: async (query: string) => query,
		...overrides,
	};
}

function curatorOptions(): any {
	return {
		queries: ["q"],
		sessionToken: "tok",
		timeout: 60,
		availableProviders: { all: false },
		defaultProvider: "exa",
		searchProvider: "exa",
		summaryModels: [],
		defaultSummaryModel: null,
	};
}

describe("curator request handling", () => {
	it("decodes split UTF-8 request bodies once", async () => {
		let received = "";
		const handle = await startCuratorServer(curatorOptions(), curatorCallbacks({
			onAddSearch: async (query: string) => {
				received = query;
				return [];
			},
		}));
		try {
			const port = Number(new URL(handle.url).port);
			const body = Buffer.from(JSON.stringify({ token: "tok", query: "東京 😀" }), "utf8");
			for (const byteOffset of [body.indexOf(0xe6) + 1, body.indexOf(0xf0) + 2]) {
				await new Promise<void>((resolve, reject) => {
					const socket = net.connect(port, "127.0.0.1", () => {
						socket.write(`POST /search HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
						socket.write(body.subarray(0, byteOffset));
						setTimeout(() => socket.write(body.subarray(byteOffset)), 5);
					});
					socket.on("error", reject);
					socket.on("data", () => socket.destroy());
					socket.on("close", () => resolve());
				});
				expect(received).toBe("東京 😀");
			}
		} finally {
			handle.close();
		}
	});

	it("aborts rewrite work when the response connection closes", async () => {
		let started!: () => void;
		const didStart = new Promise<void>(resolve => { started = resolve; });
		let aborted!: () => void;
		const didAbort = new Promise<void>(resolve => { aborted = resolve; });
		const handle = await startCuratorServer(curatorOptions(), curatorCallbacks({
			onRewriteQuery: (_query: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
				started();
				signal.addEventListener("abort", () => {
					aborted();
					reject(new Error("aborted"));
				}, { once: true });
			}),
		}));
		try {
			const payload = JSON.stringify({ token: "tok", query: "hello" });
			const request = http.request({
				host: "127.0.0.1",
				port: Number(new URL(handle.url).port),
				path: "/rewrite",
				method: "POST",
				headers: { "content-length": Buffer.byteLength(payload) },
			});
			request.on("error", () => {});
			request.end(payload);
			await didStart;
			request.destroy();
			await Promise.race([didAbort, new Promise((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 500))]);
		} finally {
			handle.close();
		}
	});
});

function minimalPdf(text: string): ArrayBuffer {
	const objects: Array<string | null> = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		null,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
	objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	let output = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(output.length);
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = output.length;
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(output).buffer as ArrayBuffer;
}

describe("PDF artifacts", () => {
	it("uses collision-resistant names and cleans only the owned session directory", async () => {
		const callerDirectory = temporaryDirectory("pie-pdf-caller-");
		for (let index = 0; index < 101; index++) {
			await extractPDFToMarkdown(minimalPdf("hello"), `https://example.test/download?id=${index}`, { outputDir: callerDirectory });
		}
		expect(readdirSync(callerDirectory)).toHaveLength(101);
		const owned = await extractPDFToMarkdown(minimalPdf("owned"), "https://example.test/owned.pdf");
		expect(existsSync(owned.outputPath)).toBe(true);
		clearPdfArtifacts();
		expect(existsSync(owned.outputPath)).toBe(false);
		expect(readdirSync(callerDirectory)).toHaveLength(101);
	});
});

describe("GitHub extraction", () => {
	it("resolves the longest slash-named ref before splitting the path", async () => {
		const bin = temporaryDirectory("pie-git-");
		writeFileSync(join(bin, "git"), "#!/bin/sh\nprintf 'abc\\trefs/heads/feature/payments\\nabc\\trefs/heads/feature/payments/src\\n'\n");
		chmodSync(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${originalPath}`;
		const url = "https://github.com/acme/widget/blob/feature/payments/src/index.ts";
		const parsed = parseGitHubUrl(url);
		expect(parsed).not.toBeNull();
		await expect(resolveGitHubUrlInfo(url, parsed!, 1000)).resolves.toMatchObject({
			ref: "feature/payments/src",
			path: "index.ts",
		});
	});

	it("applies explicit proxy and explicit-direct settings to every gh invocation", async () => {
		const bin = temporaryDirectory("pie-gh-");
		const log = join(bin, "gh.log");
		writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s|%s\\n' "$HTTPS_PROXY" "$*" >> '${log}'\nif [ "$1" = "--version" ]; then echo gh; exit 0; fi\nif [ "$1" = "pr" ]; then echo '{"title":"T","number":1,"state":"OPEN","author":{"login":"a"},"comments":[],"reviews":[],"files":[],"commits":[],"labels":[]}'; exit 0; fi\necho '[]'\n`);
		chmodSync(join(bin, "gh"), 0o755);
		process.env.PATH = `${bin}:${originalPath}`;
		for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[key];
		await runWithProxy("http://127.0.0.1:3128", () => extractGitHubIssuePr("https://github.com/o/r/pull/1"));
		let lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines.every(line => line.startsWith("http://127.0.0.1:3128/|"))).toBe(true);
		writeFileSync(log, "");
		process.env.HTTPS_PROXY = "http://ambient.invalid:8080";
		await runWithProxy("", () => extractGitHubIssuePr("https://github.com/o/r/pull/1"));
		lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.every(line => line.startsWith("|"))).toBe(true);
	});
});
