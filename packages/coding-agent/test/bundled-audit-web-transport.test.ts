import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { connect, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { constants, createGzip, gzipSync } from "node:zlib";
import {
	Agent,
	getGlobalDispatcher,
	ProxyAgent,
	setGlobalDispatcher,
	type Request as UndiciRequest,
} from "undici/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractContent } from "../../pi-web-access/extract.ts";
import { fetchRemoteUrl } from "../../pi-web-access/ssrf-protection.ts";
import { fetchWithDispatcher, installGlobalProxyFetch, runWithProxy } from "../../pi-web-access/utils.ts";
import { deferred, fixtureLookup } from "./bundled-audit-fixtures.ts";

const config = vi.hoisted(() => {
	const dir = `${process.env.TMPDIR ?? "/tmp"}/pie-transport-config-${process.pid}-${Date.now()}`;
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("PIE_CODING_AGENT_DIR", dir);
	return { dir };
});
vi.mock("../../pi-web-access/chrome-cookies.ts", () => ({
	getBrowserCookiesForHosts: vi.fn(async () => ({ cookieHeader: "fixture=value" })),
	getLastBrowserCookieDiagnostic: () => "fixture",
}));

const nativeFetch = globalThis.fetch;
// Exercise the extension's declared Undici version, not an accidentally hoisted
// Request class. The separate runtime fixture covers actual host startup.
const { Request: WebUndiciRequest, fetch: webUndiciFetch } = createRequire(
	new URL("../../pi-web-access/package.json", import.meta.url),
)("undici/index.js") as { Request: typeof UndiciRequest; fetch: typeof nativeFetch };
const servers: Server[] = [];
const tunnelSockets: Duplex[] = [];
let root: string;
beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", config.dir);
	vi.stubEnv("PIE_CODING_AGENT_DIR", config.dir);
	root = mkdtempSync(join(tmpdir(), "pie-transport-audit-"));
	// Module-level config paths were captured in the owned hoisted directory.
	writeConfig({});
	for (const key of [
		"HTTP_PROXY",
		"http_proxy",
		"HTTPS_PROXY",
		"https_proxy",
		"ALL_PROXY",
		"all_proxy",
		"NO_PROXY",
		"no_proxy",
	])
		vi.stubEnv(key, "");
	vi.spyOn(dns, "lookup").mockImplementation(fixtureLookup((hostname) => (isIP(hostname) ? hostname : "127.0.0.1")));
	installGlobalProxyFetch();
});
afterEach(async () => {
	globalThis.fetch = nativeFetch;
	vi.restoreAllMocks();
	for (const socket of tunnelSockets.splice(0)) socket.destroy();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	rmSync(root, { recursive: true, force: true });
	rmSync(config.dir, { recursive: true, force: true });
});

function writeConfig(value: Record<string, unknown>) {
	// mkdir is local to this test's config, never the user's config directory.
	mkdirSync(config.dir, { recursive: true });
	writeFileSync(join(config.dir, "web-search.json"), JSON.stringify(value));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, host = "127.0.0.1", port = 0) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host, port, ipv6Only: true }, resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
	return { server, port: address.port, url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
}

async function body(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

describe("proxy Fetch semantics and streaming", () => {
	it("preserves Request data, init precedence, replayable redirect bodies, and HEAD", async () => {
		const seen: Array<{ method?: string; body: string; header?: string; url?: string }> = [];
		const proxy = await listen((req, res) => {
			void body(req).then((content) => {
				seen.push({
					method: req.method,
					body: content,
					header: req.headers["x-fixture"] as string | undefined,
					url: req.url,
				});
				if (req.url?.endsWith("/redirect")) {
					res.writeHead(307, { location: "/final" });
					res.end();
				} else {
					res.setHeader("content-type", "text/plain");
					res.end("complete");
				}
			});
		});
		await runWithProxy(proxy.url, async () => {
			const post = new Request("http://request.invalid/redirect", {
				method: "POST",
				headers: { "x-fixture": "original" },
				body: "payload",
			});
			expect(await (await fetch(post)).text()).toBe("complete");
			expect(post.bodyUsed).toBe(true);
			expect(
				await (
					await fetch(
						new Request("http://request.invalid/override", {
							method: "POST",
							body: "old",
							headers: { "x-fixture": "old" },
						}),
						{ method: "PUT", body: "new", headers: [["x-fixture", "new"]] },
					)
				).text(),
			).toBe("complete");
			const head = await fetch(new URL("http://request.invalid/head"), { method: "HEAD" });
			expect(head.body).toBeNull();
			expect(await head.text()).toBe("");
		});
		expect(seen).toEqual([
			{ method: "POST", body: "payload", header: "original", url: "http://request.invalid/redirect" },
			{ method: "POST", body: "payload", header: "original", url: "http://request.invalid/final" },
			{ method: "PUT", body: "new", header: "new", url: "http://request.invalid/override" },
			{ method: "HEAD", body: "", header: undefined, url: "http://request.invalid/head" },
		]);
	});

	it("returns headers before EOF and cancellation closes the transfer", async () => {
		let complete = () => {};
		const closed = deferred<void>();
		const proxy = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain", "content-length": "10000000" });
			res.write("first");
			complete = () => res.end("last");
			res.on("close", () => closed.resolve());
		});
		await runWithProxy(proxy.url, async () => {
			const pending = fetch("http://stream.invalid/");
			const result = await Promise.race([
				pending,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
			]);
			if (!result) {
				complete();
				await pending.then((response) => response.body?.cancel());
			}
			expect(result).not.toBeNull();
			await result?.body?.cancel();
			await closed.promise;
		});
	});

	it("propagates truncated transfer failures while retaining HTTP error bodies", async () => {
		const proxy = await listen((req, res) => {
			if (req.url?.endsWith("/error")) {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("missing");
				return;
			}
			res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
			res.write("partial");
			setTimeout(() => res.destroy(), 30);
		});
		await runWithProxy(proxy.url, async () => {
			await expect(fetch("http://partial.invalid/").then((response) => response.text())).rejects.toThrow();
			const response = await fetch("http://partial.invalid/error");
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("missing");
		});
	});

	it("strips credentials across origins but keeps ordinary headers and honors proxy auth", async () => {
		const seen: IncomingMessage["headers"][] = [];
		const proxy = await listen((req, res) => {
			seen.push(req.headers);
			if (seen.length === 1) res.writeHead(302, { location: "http://other.invalid/final" });
			res.end("ok");
		});
		await runWithProxy(proxy.url.replace("http://", "http://fixture:password@"), async () => {
			await (
				await fetch("http://first.invalid/", {
					headers: { authorization: "Bearer fixture", cookie: "fixture=yes", "x-fixture": "retained" },
				})
			).text();
		});
		expect(seen[0]?.["proxy-authorization"]).toBe(`Basic ${Buffer.from("fixture:password").toString("base64")}`);
		expect(seen[1]?.authorization).toBeUndefined();
		expect(seen[1]?.cookie).toBeUndefined();
		expect(seen[1]?.["x-fixture"]).toBe("retained");
	});

	it("honors Request abort and direct loopback bypass", async () => {
		let proxyCalls = 0;
		const proxy = await listen((_req, res) => {
			proxyCalls++;
			res.end("proxy");
		});
		const direct = await listen((_req, res) => res.end("direct"));
		await runWithProxy(proxy.url, async () => {
			const controller = new AbortController();
			controller.abort();
			await expect(fetch(new Request("http://abort.invalid/", { signal: controller.signal }))).rejects.toThrow();
			expect(await (await fetch(direct.url)).text()).toBe("direct");
		});
		expect(proxyCalls).toBe(0);
	});

	it("supports its imported Undici Request independently of host globals", async () => {
		const proxy = await listen((req, res) => {
			void body(req).then((content) => {
				res.end(`${req.method}:${content}`);
			});
		});
		const request = new WebUndiciRequest("http://bundled.invalid/", { method: "POST", body: "bundled" });
		await runWithProxy(proxy.url, async () => {
			expect(await (await fetch(request as Request)).text()).toBe("POST:bundled");
		});
		const baseline = new WebUndiciRequest(proxy.url, { method: "POST", body: "bundled" });
		await (await webUndiciFetch(baseline as Request)).text();
		expect(request.bodyUsed).toBe(baseline.bodyUsed);
	});

	it("forces direct overrides and per-port NO_PROXY even with a host environment dispatcher", async () => {
		let proxied = 0;
		const proxy = await listen((_req, res) => {
			proxied++;
			res.end("proxy");
		});
		const direct = await listen((_req, res) => {
			res.end("direct");
		});
		const original = getGlobalDispatcher();
		const hostDispatcher = new ProxyAgent(proxy.url);
		setGlobalDispatcher(hostDispatcher);
		try {
			expect(
				await runWithProxy("", async () => (await fetch(`http://fixture.invalid:${direct.port}/`)).text()),
			).toBe("direct");
			await runWithProxy(proxy.url, async () => {
				expect(await (await fetch(direct.url)).text()).toBe("direct");
				vi.stubEnv("NO_PROXY", `fixture.invalid:${direct.port}`);
				expect(await (await fetch(`http://fixture.invalid:${direct.port}/`)).text()).toBe("direct");
				vi.stubEnv("NO_PROXY", `fixture.invalid:${direct.port + 1}`);
				expect(await (await fetch(`http://fixture.invalid:${direct.port}/`)).text()).toBe("proxy");
			});
			expect(proxied).toBe(1);
		} finally {
			setGlobalDispatcher(original);
			await hostDispatcher.destroy();
		}
	});

	it("does not put a web extraction cap on unrelated global Fetch callers", async () => {
		const proxy = await listen((_req, res) => {
			res.end(Buffer.alloc(6 * 1024 * 1024, 120));
		});
		await runWithProxy(proxy.url, async () => {
			expect((await (await fetch("http://provider.invalid/")).arrayBuffer()).byteLength).toBe(6 * 1024 * 1024);
		});
	});

	it("owns dispatcher teardown through success, cancellation and connection error", async () => {
		const fixture = await listen((req, res) => {
			if (req.url === "/cancel") {
				res.writeHead(200);
				res.write("pending");
			} else if (req.url === "/error") req.socket.destroy();
			else res.end("ok");
		});
		for (const path of ["/success", "/head", "/cancel", "/error"]) {
			const agent = new Agent();
			if (path === "/error") await expect(fetchWithDispatcher(`${fixture.url}${path}`, {}, agent)).rejects.toThrow();
			else {
				const response = await fetchWithDispatcher(
					`${fixture.url}${path}`,
					{ method: path === "/head" ? "HEAD" : "GET" },
					agent,
				);
				if (path === "/cancel") await response.body?.cancel();
				else if (path === "/head") expect(response.body).toBeNull();
				else expect(await response.text()).toBe("ok");
			}
			await vi.waitFor(() => expect(agent.destroyed).toBe(true));
		}
	});
});

describe("protected connection binding and extraction limits", () => {
	it("connects only to the exact DNS answers it validated", async () => {
		let sentinelCalls = 0;
		const approved = await listen((req, res) => {
			res.end(req.headers.host);
		});
		await listen(
			(_req, res) => {
				sentinelCalls++;
				res.end("INTERNAL SENTINEL");
			},
			"::1",
			approved.port,
		);
		const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
		const systemLookup = vi.spyOn(dns, "lookup").mockImplementation(fixtureLookup(() => "::1"));
		systemLookup.mockClear();
		const url = `http://rebind.invalid:${approved.port}/`;
		const response = await fetchRemoteUrl(url, {}, { lookup, allowRanges: ["127.0.0.1/32"] });
		expect(await response.text()).toBe(`rebind.invalid:${approved.port}`);
		expect(sentinelCalls).toBe(0);
		expect(systemLookup).not.toHaveBeenCalled();
		expect(lookup).toHaveBeenCalledOnce();
	});

	it("validates each redirect and cancels rejected redirect bodies", async () => {
		const closed = deferred<void>();
		const first = await listen((_req, res) => {
			res.writeHead(302, { location: `http://internal.invalid:${first.port}/` });
			res.write("redirect");
			res.on("close", () => closed.resolve());
		});
		const lookup = vi.fn(async (host: string) => [
			{ address: host === "first.invalid" ? "127.0.0.1" : "::1", family: host === "first.invalid" ? 4 : 6 },
		]);
		await expect(
			fetchRemoteUrl(`http://first.invalid:${first.port}/`, {}, { lookup, allowRanges: ["127.0.0.1/32"] }),
		).rejects.toThrow("Blocked internal address");
		await Promise.race([
			closed.promise,
			new Promise<void>((_resolve, reject) =>
				setTimeout(() => reject(new Error("redirect body not canceled")), 500),
			),
		]);
	});

	it("requires explicit trust for the selected proxy, while a direct override remains pinned", async () => {
		let calls = 0;
		const proxy = await listen((_req, res) => {
			calls++;
			res.end("trusted proxy");
		});
		const lookup = vi.fn(async () => [{ address: "203.0.113.1", family: 4 }]);
		await runWithProxy(proxy.url, async () => {
			await expect(fetchRemoteUrl("http://proxy-target.invalid/", {}, { lookup })).rejects.toThrow(
				"ssrf.trustEnvProxy",
			);
			expect(calls).toBe(0);
			const response = await fetchRemoteUrl("http://proxy-target.invalid/", {}, { trustEnvProxy: true, lookup });
			expect(await response.text()).toBe("trusted proxy");
			await expect(
				runWithProxy("", () =>
					fetchRemoteUrl(
						"http://direct.invalid/",
						{},
						{ trustEnvProxy: true, lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
					),
				),
			).rejects.toThrow("Blocked internal address");
		});
		expect(calls).toBe(1);
		expect(lookup).not.toHaveBeenCalled();
	});

	it("applies the PDF-specific cap and discards truncated raw extraction content", async () => {
		let calls = 0;
		const proxy = await listen((req, res) => {
			calls++;
			if (req.url?.endsWith(".pdf")) {
				res.writeHead(200, { "content-type": "application/pdf", "content-length": String(2 * 1024 * 1024) });
				res.write("%PDF");
			} else {
				res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
				res.write("partial");
				setTimeout(() => res.destroy(), 20);
			}
		});
		writeConfig({ ssrf: { trustEnvProxy: true }, pdf: { maxSizeMB: 1 } });
		const options = { mode: "raw" as const, proxy: proxy.url };
		expect((await extractContent("http://limit.invalid/report.pdf", undefined, options)).error).toContain(
			"pdf.maxSizeMB limit (1 MB)",
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await extractContent("http://limit.invalid/partial", undefined, options);
			expect(result.error).toBeTruthy();
			expect(result.content).toBe("");
		}
		expect(calls).toBe(3);
	});

	it("caps decoded bytes even when a compressed body fits in a single network buffer", async () => {
		const compressed = gzipSync(Buffer.alloc(8 * 1024 * 1024, 120));
		expect(compressed.byteLength).toBeLessThan(64 * 1024);
		const proxy = await listen((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/plain",
				"content-encoding": "gzip",
				"content-length": String(compressed.byteLength),
			});
			res.end(compressed);
		});
		writeConfig({ ssrf: { trustEnvProxy: true } });
		const result = await extractContent("http://compressed.invalid/", undefined, { mode: "raw", proxy: proxy.url });
		expect(result.error).toContain("Response too large");
		expect(result.content).toBe("");
	});

	it("rejects mixed private answers, literal internal addresses and denied domains before transport", async () => {
		const lookup = vi.fn(async () => [
			{ address: "203.0.113.1", family: 4 },
			{ address: "::1", family: 6 },
		]);
		await expect(fetchRemoteUrl("http://mixed.invalid/", {}, { lookup })).rejects.toThrow("Blocked internal address");
		await expect(fetchRemoteUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow("Blocked internal address");
		await expect(
			fetchRemoteUrl(
				"http://denied.invalid/",
				{},
				{ lookup, domainPolicy: { allow: [], deny: ["denied.invalid"] } },
			),
		).rejects.toThrow("Blocked hostname");
		expect(lookup).toHaveBeenCalledOnce();
	});

	it.each(["declared", "chunked", "gzip"])("enforces extraction size bounds during %s transfer", async (mode) => {
		let sent = 0;
		const closed = deferred<void>();
		const proxy = await listen((_req, res) => {
			res.setHeader("content-type", "text/plain");
			if (mode === "declared") res.setHeader("content-length", String(32 * 1024 * 1024));
			const gzip = mode === "gzip" ? createGzip({ flush: constants.Z_SYNC_FLUSH }) : undefined;
			if (gzip) {
				res.setHeader("content-encoding", "gzip");
				gzip.pipe(res);
			}
			const output = gzip ?? res;
			// Bound bytes on the wire here. Highly compressible read-ahead is tested separately.
			const chunk = gzip ? randomBytes(64 * 1024) : Buffer.alloc(64 * 1024, 120);
			let timer: ReturnType<typeof setTimeout>;
			const send = () => {
				if (res.destroyed) return;
				sent += 64 * 1024;
				const ready = output.write(chunk);
				if (sent >= 32 * 1024 * 1024) output.end();
				else if (ready) timer = setTimeout(send, 1);
				else
					output.once("drain", () => {
						timer = setTimeout(send, 1);
					});
			};
			timer = setTimeout(send, 1);
			res.on("close", () => {
				clearTimeout(timer);
				gzip?.destroy();
				closed.resolve();
			});
		});
		writeConfig({ ssrf: { trustEnvProxy: true } });
		const result = await extractContent("http://size.invalid/", undefined, {
			mode: "raw",
			proxy: proxy.url,
			// This tests byte bounds, not compression throughput under parallel CI
			// load. Keep a deadline without letting it preempt the size rejection.
			timeoutMs: 10_000,
			lookup: async () => [{ address: "203.0.113.1", family: 4 }],
		});
		expect(result.error).toContain("Response too large");
		expect(result.content).toBe("");
		await closed.promise;
		expect(sent).toBeLessThan(mode === "declared" ? 1024 * 1024 : 7 * 1024 * 1024);
	});
});

async function secureFixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
	const keyPath = join(root, "key.pem");
	const certPath = join(root, "cert.pem");
	const sslConfig = join(root, "openssl.conf");
	writeFileSync(
		sslConfig,
		"[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:auth.invalid,DNS:other.invalid\n",
	);
	const generated = spawnSync(
		"/usr/bin/openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=auth.invalid",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-extensions",
			"v3",
			"-config",
			sslConfig,
		],
		{ encoding: "utf8" },
	);
	if (generated.status !== 0) throw new Error(generated.stderr);
	const cert = readFileSync(certPath);
	const originalConnect = tls.connect;
	vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) =>
		originalConnect({ ...options, ca: cert })) as typeof tls.connect);
	const server = createHttpsServer({ key: readFileSync(keyPath), cert }, handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No TLS fixture address");
	return { server, port: address.port, url: `https://auth.invalid:${address.port}` };
}

describe("authenticated and proxy HTTPS transport", () => {
	it("pins auth connections with hostname/SNI intact and never uses an unsafe global fetch", async () => {
		const seen: Array<{ path?: string; host?: string; cookie?: string }> = [];
		const secure = await secureFixture((req, res) => {
			seen.push({ path: req.url, host: req.headers.host, cookie: req.headers.cookie });
			res.setHeader("content-type", "text/plain");
			if (req.url === "/start") res.writeHead(302, { location: "/final" });
			res.end("authenticated fixture");
		});
		writeConfig({ ssrf: { allowRanges: ["127.0.0.1/32"] } });
		const unsafeGlobal = vi.fn(async () => new Response("UNSAFE GLOBAL TRANSPORT"));
		globalThis.fetch = unsafeGlobal;
		vi.spyOn(dns, "lookup").mockImplementation(fixtureLookup(() => "::1"));
		const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
		const result = await extractContent(`${secure.url}/start`, undefined, {
			mode: "raw",
			lookup,
			authFetchProfile: { name: "fixture", hosts: ["auth.invalid"], redirects: "same-origin", cache: "off" },
		});
		expect(result).toMatchObject({ content: "authenticated fixture", error: null });
		expect(unsafeGlobal).not.toHaveBeenCalled();
		expect(seen).toEqual([
			{ path: "/start", host: `auth.invalid:${secure.port}`, cookie: "fixture=value" },
			{ path: "/final", host: `auth.invalid:${secure.port}`, cookie: "fixture=value" },
		]);
	});

	it("refuses cross-origin authenticated redirects before a second cookie-bearing request", async () => {
		let calls = 0;
		const closed = deferred<void>();
		const secure = await secureFixture((_req, res) => {
			calls++;
			res.writeHead(302, { location: `https://other.invalid:${secure.port}/final` });
			res.write("unread redirect");
			res.on("close", () => closed.resolve());
		});
		writeConfig({ ssrf: { allowRanges: ["127.0.0.1/32"] } });
		const result = await extractContent(secure.url, undefined, {
			mode: "raw",
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			authFetchProfile: {
				name: "fixture",
				hosts: ["auth.invalid", "other.invalid"],
				redirects: "same-origin",
				cache: "off",
			},
		});
		expect(result.error).toContain("Authenticated fetch refused cross-origin redirect");
		expect(calls).toBe(1);
		await closed.promise;
	});

	it("actually tunnels trusted environment proxies and never resolves their target locally", async () => {
		const secure = await secureFixture((req, res) => {
			res.end(req.headers.host);
		});
		const proxy = await listen((_req, res) => {
			res.writeHead(500);
			res.end();
		});
		const targets: string[] = [];
		proxy.server.on("connect", (req, socket, head) => {
			targets.push(req.url ?? "");
			const upstream = connect({ host: "127.0.0.1", port: secure.port }, () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				socket.pipe(upstream).pipe(socket);
			});
			tunnelSockets.push(socket, upstream);
			socket.on("error", () => upstream.destroy());
			upstream.on("error", () => socket.destroy());
		});
		vi.stubEnv("HTTPS_PROXY", proxy.url);
		const lookup = vi.fn(async () => {
			throw new Error("Local target DNS must not be used");
		});
		await expect(fetchRemoteUrl(secure.url, {}, { lookup })).rejects.toThrow("ssrf.trustEnvProxy");
		const response = await fetchRemoteUrl(secure.url, {}, { lookup, trustEnvProxy: true });
		expect(await response.text()).toBe(`auth.invalid:${secure.port}`);
		expect(targets).toEqual([`auth.invalid:${secure.port}`]);
		expect(lookup).not.toHaveBeenCalled();
	});
});
