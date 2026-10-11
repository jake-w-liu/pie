import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
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
