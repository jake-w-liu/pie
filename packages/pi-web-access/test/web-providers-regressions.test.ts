import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-providers-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
delete process.env.PIE_CODING_AGENT_DIR;
Object.assign(process.env, {
	BOCHA_API_KEY: "test-key",
	GEMINI_API_KEY: "test-key",
	OPENAI_API_KEY: "test-key",
	PERPLEXITY_API_KEY: "test-key",
	QUERIT_API_KEY: "test-key",
	SERPBASE_API_KEY: "test-key",
	TINYFISH_API_KEY: "test-key",
});

let sourceCheck: typeof import("../source-check.ts");

beforeAll(async () => {
	sourceCheck = await import("../source-check.ts");
}, 60_000);

afterAll(() => {
	globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

function artifactFor(content: string, claim: string, snippet = "") {
	const url = "https://example.com/docs";
	const artifact = sourceCheck.buildResearchArtifact({
		query: claim,
		results: [{ title: "Docs", url, snippet }],
		fetched: [{ url, title: "Docs", content, error: null }],
	});
	return sourceCheck.withClaimAssessment(artifact, [claim]);
}

describe("source-check passage extraction", () => {
	it("preserves decimals and hostnames with exact offsets", () => {
		const prefix = "Padding. ";
		const sentence = "According to the v2.5 docs at docs.example.com, the default timeout is 30 seconds.";
		const artifact = artifactFor(prefix + sentence, "The v2.5 docs say the default timeout is 30 seconds");
		expect(artifact.passages[0]?.text).toBe(sentence);
		expect(artifact.passages[0]?.extraction_span).toEqual({ start: prefix.length, end: prefix.length + sentence.length });
		expect(artifact.claims?.[0]?.status).toBe("supported");
	});

	it("prioritizes claim terms over an unrelated provider snippet", () => {
		const artifact = artifactFor(
			"These release notes describe changes to caching. According to the official documentation, the default timeout is 30 seconds.",
			"The default timeout is 30 seconds",
			"release notes caching changes",
		);
		expect(artifact.passages[0]?.text).toContain("default timeout is 30 seconds");
		expect(artifact.claims?.[0]?.status).toBe("supported");
	});

	it("scans long content without sentence boundaries in bounded time", () => {
		const started = performance.now();
		artifactFor("文".repeat(40_000), "default timeout");
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("splits claim clauses around dot leaders in linear time", () => {
		// Each table-of-contents dot run is followed by a page number, so it stays inside
		// the cited passage; the clause splitter used to try 2^(n-1) splits of every run.
		const content = [
			"Project Foo documentation.",
			"",
			"Contents",
			`Introduction${".".repeat(22)}1`,
			`Installing foo${".".repeat(22)}5`,
			"",
			"Foo supports Linux and macOS.",
		].join("\n");
		const started = performance.now();
		const artifact = artifactFor(content, "Foo supports Linux");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(artifact.passages).toHaveLength(1);
		expect(artifact.passages[0]?.text).toContain("Foo supports Linux and macOS.");
		expect(artifact.claims?.[0]?.status).toBe("unclear");
	});
});

describe("model completion stop reasons", () => {
	it("falls back from errored summary output and preserves an errored rewrite query", () => {
		const output = execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/summary-error.ts")], { encoding: "utf8" });
		expect(JSON.parse(output)).toEqual({
			summary: "complete summary",
			summaryCalls: ["anthropic", "google"],
			rewrite: "original",
			rewriteCalls: ["anthropic"],
		});
	});
});

describe("HTTP provider regressions", () => {
	it("attaches an expiring provider deadline to Perplexity", async () => {
		const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(5));
		globalThis.fetch = vi.fn(async (_input, init) => {
			const signal = init?.signal;
			expect(signal).toBeInstanceOf(AbortSignal);
			return new Promise<Response>((_resolve, reject) => {
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}) as typeof fetch;
		const { searchWithPerplexity } = await import("../perplexity.ts");
		await expect(Promise.race([
			searchWithPerplexity("q"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("provider deadline did not expire")), 250)),
		])).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeoutSpy).toHaveBeenCalledWith(30_000);
		timeoutSpy.mockRestore();
	});

	it("rejects camelCase Gemini URL retrieval failures", async () => {
		globalThis.fetch = vi.fn(async () => Response.json({ candidates: [{
			content: { parts: [{ text: "This refusal response is deliberately long enough to pass the content threshold." }] },
			urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" }] },
		}] })) as typeof fetch;
		const { extractWithUrlContext } = await import("../gemini-url-context.ts");
		expect(await extractWithUrlContext("https://example.com/a")).toBeNull();
	});

	it("keeps search results when optional inline-content endpoints fail", async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.startsWith("https://api.search.tinyfish.ai")) return Response.json({ results: [{ title: "A", url: "https://a.example/", snippet: "a" }] });
			if (url.startsWith("https://api.querit.ai/v1/search")) return Response.json({ error_code: 200, results: { result: [{ title: "A", url: "https://a.example/", snippet: "a" }] } });
			return new Response("down", { status: 503 });
		}) as typeof fetch;
		const [{ searchWithTinyFish }, { searchWithQuerit }] = await Promise.all([import("../tinyfish.ts"), import("../querit.ts")]);
		expect((await searchWithTinyFish("q", { includeContent: true })).results).toHaveLength(1);
		expect((await searchWithQuerit("q", { includeContent: true })).results).toHaveLength(1);
	});

	it("still propagates caller cancellation during inline-content enrichment", async () => {
		const { searchWithTinyFish } = await import("../tinyfish.ts");
		const controller = new AbortController();
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input);
			if (url.startsWith("https://api.search.tinyfish.ai")) return Response.json({ results: [{ title: "A", url: "https://a.example/", snippet: "a" }] });
			controller.abort(new DOMException("cancelled", "AbortError"));
			throw controller.signal.reason;
		}) as typeof fetch;
		await expect(searchWithTinyFish("q", { includeContent: true, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	});

	it("does not send OpenAI's unsupported blocked_domains filter", async () => {
		let body: { tools?: Array<{ filters?: Record<string, unknown> }> } = {};
		globalThis.fetch = vi.fn(async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ output: [
				{ type: "web_search_call", action: { sources: [{ url: "https://allowed.example", title: "A" }] } },
				{ type: "message", content: [{ text: "answer", annotations: [] }] },
			] });
		}) as typeof fetch;
		const { searchWithOpenAI } = await import("../openai-search.ts");
		await searchWithOpenAI("q", { domainFilter: ["-blocked.example"] });
		expect(body.tools?.[0]?.filters).toBeUndefined();
	});

	it("requests the tool-wide default count from Bocha and SerpBase", async () => {
		const counts: string[] = [];
		globalThis.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			if (url.includes("bocha")) {
				counts.push(String(JSON.parse(String(init?.body)).count));
				return Response.json({ code: 200, data: { webPages: { value: [] } } });
			}
			counts.push(new URL(url).searchParams.get("num") ?? "");
			return Response.json({ organic_results: [] });
		}) as typeof fetch;
		const [{ searchWithBocha }, { searchWithSerpBase }] = await Promise.all([import("../bocha.ts"), import("../serpbase.ts")]);
		await searchWithBocha("q");
		await searchWithSerpBase("q");
		expect(counts).toEqual(["5", "5"]);
	});
});

describe("Gemini grounding redirects", () => {
	it("resolves redirects concurrently in order and propagates caller abort", () => {
		const output = execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/gemini-redirects.ts")], { encoding: "utf8" });
		const result = JSON.parse(output) as { maxActive: number; urls: string[]; abortName: string };
		expect(result.maxActive).toBeGreaterThan(1);
		expect(result.urls).toEqual(Array.from({ length: 6 }, (_, index) => `https://source-${index}.example/`));
		expect(result.abortName).toBe("AbortError");
	}, 15_000);
});

describe("extension control-flow regressions", () => {
	type RegisteredTool = { name: string; execute: (...args: any[]) => Promise<any> };
	type RegisteredShortcut = { handler: (ctx: any) => Promise<void> };
	let tools: Map<string, RegisteredTool>;
	let shortcuts: Map<string, RegisteredShortcut>;
	let fetchBehavior: typeof fetch;
	let routedFetch: typeof fetch;
	let context: any;
	let extensionExec: ReturnType<typeof vi.fn>;

	beforeAll(async () => {
		writeFileSync(join(testAgentDir, "web-search.json"), JSON.stringify({ autoOpenBrowser: false }));
		fetchBehavior = originalFetch;
		routedFetch = vi.fn((input, init) => fetchBehavior(input, init)) as typeof fetch;
		globalThis.fetch = routedFetch;

		tools = new Map();
		shortcuts = new Map();
		extensionExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
		const extensionApi = {
			registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
			registerShortcut(key: string, shortcut: RegisteredShortcut) { shortcuts.set(key, shortcut); },
			registerCommand() {},
			on() {},
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
			exec: extensionExec,
		};
		const { default: initializeExtension } = await import("../index.ts");
		initializeExtension(extensionApi as any);
		context = {
			hasUI: true,
			cwd: testAgentDir,
			model: undefined,
			modelRegistry: {
				getAll: () => [],
				getAvailable: () => [],
				find: () => undefined,
			},
			isProjectTrusted: () => true,
			ui: { notify: vi.fn(), setWidget: vi.fn() },
		};
	}, 60_000);

	async function startCuratedSearch(query: string) {
		fetchBehavior = vi.fn(async () => Response.json({
			choices: [{ message: { content: `answer for ${query}` } }],
			citations: [],
		})) as typeof fetch;
		let publishUrl!: (url: string) => void;
		const urlPublished = new Promise<string>(resolve => { publishUrl = resolve; });
		const pending = tools.get("web_search")!.execute(
			`call-${query}`,
			{ query, provider: "perplexity", workflow: "summary-review" },
			undefined,
			(update: any) => {
				if (typeof update.details?.curatorUrl === "string") publishUrl(update.details.curatorUrl);
			},
			context,
		);
		const url = await Promise.race([
			urlPublished,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("curator URL was not published")), 2_000)),
		]);
		return { pending, url, token: new URL(url).searchParams.get("session")! };
	}

	async function postCurator(url: string, path: string, body: Record<string, unknown>) {
		const response = await originalFetch(new URL(path, url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.ok).toBe(true);
	}

	it("persists searchProvider and resolves it on the next search", async () => {
		const { pending, url, token } = await startCuratedSearch("persist-provider");
		await postCurator(url, "/provider", { token, provider: "bocha" });
		await vi.waitFor(() => {
			expect(JSON.parse(readFileSync(join(testAgentDir, "web-search.json"), "utf8"))).toMatchObject({ searchProvider: "bocha" });
		});
		await postCurator(url, "/cancel", { token, reason: "user" });
		await pending;

		const requestedUrls: string[] = [];
		fetchBehavior = vi.fn(async (input) => {
			requestedUrls.push(String(input));
			return Response.json({ code: 200, data: { webPages: { value: [] } } });
		}) as typeof fetch;
		await tools.get("web_search")!.execute(
			"resolved-provider",
			{ query: "uses persisted provider", workflow: "none" },
			undefined,
			undefined,
			{ ...context, hasUI: false },
		);
		expect(requestedUrls).toHaveLength(1);
		expect(requestedUrls[0]).toContain("api.bochaai.com");
	});

	it("reopens an already-active curator URL", async () => {
		const bin = mkdtempSync(join(tmpdir(), "pi-web-open-"));
		const log = join(bin, "opened.log");
		const previousPath = process.env.PATH;
		if (platform() !== "darwin" && platform() !== "win32") {
			writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s' "$1" > '${log}'\n`);
			chmodSync(join(bin, "xdg-open"), 0o755);
			process.env.PATH = `${bin}:${previousPath}`;
		}
		try {
			const { pending, url, token } = await startCuratedSearch("reopen-curator");
			extensionExec.mockClear();
			await shortcuts.get("ctrl+shift+s")!.handler(context);
			if (platform() === "darwin") {
				expect(extensionExec).toHaveBeenCalledWith("open", [url]);
			} else if (platform() === "win32") {
				expect(extensionExec).toHaveBeenCalledWith("cmd", ["/c", "start", "", url]);
			} else {
				await vi.waitFor(() => expect(readFileSync(log, "utf8")).toBe(url));
			}
			expect(context.ui.notify).toHaveBeenCalledWith("Reopened search curator", "info");
			await postCurator(url, "/cancel", { token, reason: "user" });
			await pending;
		} finally {
			process.env.PATH = previousPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("continues after a provider TimeoutError and records the failure", async () => {
		let calls = 0;
		fetchBehavior = vi.fn(async () => {
			calls++;
			if (calls === 1) {
				const error = new Error("provider deadline exceeded");
				error.name = "TimeoutError";
				throw error;
			}
			return Response.json({ choices: [{ message: { content: "second answer" } }], citations: [] });
		}) as typeof fetch;
		const result = await tools.get("web_search")!.execute(
			"timeout-continuation",
			{ queries: ["first", "second"], provider: "perplexity", workflow: "none" },
			undefined,
			undefined,
			{ ...context, hasUI: false },
		);
		expect(calls).toBe(2);
		expect(result.details).toMatchObject({ queryCount: 2, successfulQueries: 1 });
		expect(result.content[0].text).toContain("Error: provider deadline exceeded");
		expect(result.content[0].text).toContain("second answer");
	});
});

describe("Gemini transport resources", () => {
	it("bounds proxy dispatchers and closes evicted and retained entries", async () => {
		const closed: number[] = [];
		let nextId = 0;
		class Dispatcher {}
		class FakeDispatcher extends Dispatcher {
			readonly id = nextId++;
			async close() { closed.push(this.id); }
		}
		const undici = {
			Dispatcher,
			Agent: FakeDispatcher,
			ProxyAgent: FakeDispatcher,
			EnvHttpProxyAgent: FakeDispatcher,
			fetch: async () => new Response("ok"),
		} as unknown as typeof import("undici");
		const { createGeminiFetch, GEMINI_DISPATCHER_CACHE_SIZE } = await import("../gemini-web.ts");
		const { runWithProxy } = await import("../utils.ts");
		const geminiFetch = createGeminiFetch(undici);
		for (let index = 0; index < GEMINI_DISPATCHER_CACHE_SIZE + 4; index++) {
			await runWithProxy(`http://proxy-${index}.example`, () => geminiFetch("https://example.com"));
		}
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(closed).toHaveLength(4);
		await geminiFetch.close?.();
		expect(closed).toHaveLength(GEMINI_DISPATCHER_CACHE_SIZE + 4);
	});
});
