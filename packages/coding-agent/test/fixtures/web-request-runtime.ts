// Establish the actual host globals before evaluating the extension modules.
import "./web-request-runtime-setup.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { Agent, getGlobalDispatcher, fetch as undiciFetch } from "undici/index.js";
import { resolveGeminiFetch } from "../../../pi-web-access/gemini-web.ts";
import { fetchRemoteUrl } from "../../../pi-web-access/ssrf-protection.ts";
import { installGlobalProxyFetch, runWithProxy } from "../../../pi-web-access/utils.ts";
import { fetchWithResponseErrors } from "../../src/core/http-response.ts";
import { initialDispatcher, mode } from "./web-request-runtime-setup.ts";

const webRequire = createRequire(new URL("../../../pi-web-access/package.json", import.meta.url));
const { Request: WebRequest } = webRequire("undici/index.js") as { Request: typeof Request };
if (mode === "host")
	assert.notEqual(globalThis.Request, WebRequest, "Exercise distinct installed Undici Request brands");
const compatibleFetch = globalThis.fetch;
installGlobalProxyFetch();
const wrappedFetch = globalThis.fetch;

const servers: Server[] = [];
let assertions = 0;
function check(condition: unknown, message: string) {
	assert.ok(condition, message);
	assertions++;
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { server, port: address.port, url: `http://127.0.0.1:${address.port}` };
}
async function textBody(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}
interface Echo {
	method: string;
	body: string;
	header?: string;
	authorization?: string;
	cookie?: string;
	proxyAuthorization?: string;
	host?: string;
}
let cancelClosed = () => {};
let finishRedirect = () => {};
let proxyCalls = 0;
try {
	const direct = await listen((request, response) => {
		if (request.url === "/headers") response.setHeader("x-large-fixture", "x".repeat(20_000));
		if (request.url === "/truncated") {
			response.writeHead(200, { "content-length": 100 });
			response.write("partial");
			setTimeout(() => response.destroy(), 10);
		} else if (request.url === "/bad-gzip") {
			response.setHeader("content-encoding", "gzip");
			response.end("not gzip");
		} else if (request.url === "/empty") response.end();
		else if (request.url === "/stream") response.write("first");
		else response.end(request.headers.host);
	});
	const syntheticAgent = new Agent();
	try {
		const untouched = new Response("native response");
		assert.equal(await fetchWithResponseErrors(syntheticAgent, async () => untouched), untouched);
		await untouched.text();
		const mutable = await fetchWithResponseErrors(syntheticAgent, async (dispatcher) => {
			await (await undiciFetch(direct.url, { dispatcher })).text();
			return new Response("field=value", { headers: { "content-type": "application/octet-stream" } });
		});
		const mutableClone = mutable.clone();
		mutable.headers.set("content-type", "application/x-www-form-urlencoded");
		assert.equal(mutableClone.headers.get("content-type"), "application/octet-stream");
		mutableClone.headers.set("content-type", "application/x-www-form-urlencoded");
		mutableClone.headers.set("x-clone-only", "yes");
		assert.equal(mutable.headers.has("x-clone-only"), false);
		assert.equal((await mutable.formData()).get("field"), "value");
		assert.equal((await mutableClone.formData()).get("field"), "value");
		assert.equal(mutable.bodyUsed, true);
		assert.equal(mutableClone.bodyUsed, true);
		await assert.rejects(mutable.text());
		check(true, "Mutable/default headers remain coupled to body parsing and independent across clones");
		for (const path of ["/", "/empty", "/truncated", "/stream"]) {
			const controller = new AbortController();
			const response = await fetchWithResponseErrors(
				syntheticAgent,
				(dispatcher) =>
					undiciFetch(`${direct.url}${path}`, {
						dispatcher,
						signal: controller.signal,
					}) as unknown as Promise<Response>,
				controller.signal,
			);
			assert.ok(response.body);
			const reader = response.body.getReader({ mode: "byob" });
			try {
				if (path === "/stream") {
					assert.equal(new TextDecoder().decode((await reader.read(new Uint8Array(8))).value), "first");
					const pending = reader.read(new Uint8Array(8));
					controller.abort(new Error("owned BYOB abort"));
					await assert.rejects(pending);
				} else {
					const consume = async () => {
						const chunks: Uint8Array[] = [];
						while (true) {
							// Force partial fills and multiple pulls rather than one buffered read.
							const chunk = await reader.read(new Uint8Array(3));
							if (chunk.value) chunks.push(chunk.value);
							if (chunk.done) return Buffer.concat(chunks).toString();
						}
					};
					if (path === "/truncated") await assert.rejects(consume());
					else assert.equal(await consume(), path === "/empty" ? "" : `127.0.0.1:${direct.port}`);
				}
				assert.equal(response.bodyUsed, true);
			} finally {
				reader.releaseLock();
			}
		}
		check(true, "npm byte-stream readers retain partial-fill, empty EOF, truncation and abort behavior");
	} finally {
		await syntheticAgent.destroy();
	}
	const proxy = await listen((request, response) => {
		proxyCalls++;
		const path = new URL(request.url ?? "/", "http://runtime.invalid").pathname;
		void textBody(request).then((body) => {
			if (path === "/307" || path === "/308") {
				response.writeHead(Number(path.slice(1)), { location: path === "/307" ? "/308" : "/echo" });
				response.end();
			} else if (path === "/cross") {
				response.writeHead(302, { location: "http://other.invalid/echo" });
				response.end();
			} else if (path === "/bypass") {
				response.writeHead(307, { location: direct.url });
				response.end();
			} else if (path === "/gzip" || path === "/bad-gzip") {
				response.setHeader("content-encoding", "gzip");
				response.end(path === "/gzip" ? gzipSync("decoded fixture") : "not gzip");
			} else if (path === "/open-redirect") {
				response.writeHead(302, { location: "/echo" });
				response.write("abandoned redirect body");
				finishRedirect = () => response.destroy();
				response.once("close", () => cancelClosed());
			} else if (path === "/large") response.end(Buffer.alloc(6 * 1024 * 1024, 120));
			else if (path === "/stream") {
				response.write("first");
				response.once("close", () => cancelClosed());
			} else if (path === "/truncated") {
				response.writeHead(200, { "content-length": 100 });
				response.write("partial");
				setTimeout(() => response.destroy(), 10);
			} else {
				response.setHeader("content-type", "application/json");
				response.setHeader("set-cookie", ["first=1; Path=/", "second=2; Path=/"]);
				response.end(
					JSON.stringify({
						method: request.method,
						body,
						header: request.headers["x-fixture"],
						authorization: request.headers.authorization,
						cookie: request.headers.cookie,
						proxyAuthorization: request.headers["proxy-authorization"],
						host: request.headers.host,
					}),
				);
			}
		});
	});
	await runWithProxy(proxy.url.replace("http://", "http://fixture:password@"), async () => {
		for (const source of ["payload", new Blob(["payload"])]) {
			const request = new Request("http://runtime.invalid/307", {
				method: "POST",
				body: source,
				keepalive: true,
				headers: { "x-fixture": "original" },
			});
			const response = await fetch(request);
			const echo = (await response.json()) as Echo;
			check(
				echo.method === "POST" && echo.body === "payload" && echo.header === "original",
				"Replay string/Blob across 307 and 308",
			);
			// Bun 1.4.2 reports bodyUsed=false for consumed npm Undici Requests even
			// without this wrapper. Preserve the real implementation's state rather
			// than hiding that upstream mismatch with body conversion or symbols.
			const baseline = new Request(direct.url, { method: "POST", body: source, keepalive: true });
			await (await compatibleFetch(baseline)).text();
			check(request.bodyUsed === baseline.bodyUsed, "Preserve captured Fetch bodyUsed behavior");
			await assert.rejects(fetch(request));
			await assert.rejects(compatibleFetch(baseline));
			check(response.redirected && response.url.endsWith("/echo"), "Preserve redirect metadata");
			check(
				echo.proxyAuthorization === `Basic ${Buffer.from("fixture:password").toString("base64")}`,
				"Honor proxy credentials",
			);
		}
		const originalResponse = await fetch(new Request("http://runtime.invalid/307"));
		const clonedResponse = originalResponse.clone();
		check(
			clonedResponse.url === originalResponse.url &&
				clonedResponse.type === originalResponse.type &&
				clonedResponse.redirected === originalResponse.redirected &&
				clonedResponse.status === originalResponse.status &&
				clonedResponse.statusText === originalResponse.statusText,
			"Clone retains every network response metadata field",
		);
		check(clonedResponse.headers !== originalResponse.headers, "Clones have independent Headers views");
		check(
			clonedResponse.headers.getSetCookie().join("|") === "first=1; Path=/|second=2; Path=/",
			"Preserve multiple Set-Cookie headers",
		);
		const headerContext = {};
		clonedResponse.headers.forEach(function (this: object, _value, _name, headers) {
			assert.equal(this, headerContext);
			assert.equal(headers, clonedResponse.headers);
		}, headerContext);
		if (clonedResponse.type === "default") {
			clonedResponse.headers.set("x-clone-only", "yes");
			check(!originalResponse.headers.has("x-clone-only"), "Mutable native/default clone headers are independent");
		} else {
			assert.throws(() => clonedResponse.headers.set("x-clone-only", "yes"));
			assert.throws(() =>
				clonedResponse.headers.forEach((_value, _name, headers) => {
					headers.set("x-forbidden", "yes");
				}),
			);
		}
		const checkHeaderProperties = (original: Response, clone: Response) => {
			Reflect.set(clone.headers, "fixtureProperty", "clone");
			assert.equal(Reflect.get(original.headers, "fixtureProperty"), undefined);
			Object.defineProperty(clone.headers, "definedProperty", { value: true, configurable: true });
			assert.equal(Reflect.get(original.headers, "definedProperty"), undefined);
			const originalSet = original.headers.set;
			const replacement = () => {};
			clone.headers.set = replacement;
			assert.equal(clone.headers.set, replacement);
			assert.equal(original.headers.set, originalSet);
			const replacementForEach = () => {};
			clone.headers.forEach = replacementForEach;
			assert.equal(clone.headers.forEach, replacementForEach);
			Reflect.deleteProperty(clone.headers, "fixtureProperty");
			assert.equal(Reflect.get(clone.headers, "fixtureProperty"), undefined);
		};
		const controlResponse = await compatibleFetch(direct.url);
		const controlClone = controlResponse.clone();
		checkHeaderProperties(controlResponse, controlClone);
		await Promise.all([controlResponse.text(), controlClone.text()]);
		checkHeaderProperties(originalResponse, clonedResponse);
		check(true, "Header properties, method overrides, and definitions stay local to each clone");
		const [originalText, clonedText] = await Promise.all([originalResponse.text(), clonedResponse.text()]);
		check(
			originalText === clonedText && originalResponse.bodyUsed && clonedResponse.bodyUsed,
			"Clone streams have complete, independently single-use bodies",
		);
		await assert.rejects(originalResponse.text());
		assert.throws(() => clonedResponse.clone());
		const redirectedClosed = new Promise<void>((resolve) => {
			cancelClosed = resolve;
		});
		const afterRedirect = await fetch(new Request("http://runtime.invalid/open-redirect"));
		// Generic native Fetch may drain an intermediate response in the background.
		// End this owned server lease explicitly, then challenge late old-hop errors.
		finishRedirect();
		await redirectedClosed;
		check(
			((await afterRedirect.json()) as Echo).method === "GET",
			"An old redirect's failure cannot poison the next dispatch",
		);
		const original = new Request("http://runtime.invalid/echo", { method: "POST", body: "old" });
		const override = (await (
			await fetch(original, { method: "PUT", body: "new", headers: { "x-fixture": "new" } })
		).json()) as Echo;
		check(
			override.method === "PUT" && override.body === "new" && override.header === "new",
			"Init overrides Request data",
		);
		const head = await fetch(new Request("http://runtime.invalid/echo", { method: "HEAD" }));
		check(head.body === null && (await head.text()) === "", "HEAD has no body");
		check(
			(await (await fetch(new Request("http://runtime.invalid/gzip"))).text()) === "decoded fixture",
			"Foreign Request response is decompressed",
		);
		check(
			(await (await fetch(new Request("http://runtime.invalid/large"))).arrayBuffer()).byteLength ===
				6 * 1024 * 1024,
			"No extraction cap on generic Request",
		);
		const credentials = (await (
			await fetch(
				new Request("http://runtime.invalid/cross", {
					headers: { authorization: "Bearer fixture", cookie: "fixture=yes", "x-fixture": "retained" },
				}),
			)
		).json()) as Echo;
		check(
			!credentials.authorization && !credentials.cookie && credentials.header === "retained",
			"Strip credentials, not ordinary headers, across origins",
		);
		const manual = await fetch(new Request("http://runtime.invalid/307", { redirect: "manual" }));
		check(manual.status === 307 && !manual.redirected, "Preserve manual redirect mode");
		await manual.body?.cancel();
		await assert.rejects(fetch(new Request("http://runtime.invalid/307", { redirect: "error" })));
		const streamRequest = (path: string) =>
			new Request(`http://runtime.invalid/${path}`, {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("streamed"));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit & { duplex: "half" });
		check(
			((await (await fetch(streamRequest("echo"))).json()) as Echo).body === "streamed",
			"Support streamed Request body",
		);
		await assert.rejects(fetch(streamRequest("307")));
		await assert.rejects(fetch(new Request("http://runtime.invalid/truncated")).then((response) => response.text()));
		await assert.rejects(fetch(new Request("http://runtime.invalid/bad-gzip")).then((response) => response.text()));
		const concurrent = await Promise.allSettled([
			fetch(new Request("http://runtime.invalid/truncated")).then((response) => response.text()),
			fetch(new Request("http://runtime.invalid/echo")).then((response) => response.json()),
		]);
		check(
			concurrent[0]?.status === "rejected" && concurrent[1]?.status === "fulfilled",
			"A dispatch failure cannot affect a concurrent request",
		);
		const closed = new Promise<void>((resolve) => {
			cancelClosed = resolve;
		});
		const streaming = await fetch(new Request("http://runtime.invalid/stream"));
		check(streaming.body !== null, "Resolve headers without waiting for streaming EOF");
		const streamingClone = streaming.clone();
		await Promise.all([streaming.body?.cancel(), streamingClone.body?.cancel()]);
		await closed;
		const abortClosed = new Promise<void>((resolve) => {
			cancelClosed = resolve;
		});
		const duringBody = new AbortController();
		const interrupted = await fetch(new Request("http://runtime.invalid/stream", { signal: duringBody.signal }));
		const interruptedReader = interrupted.body!.getReader();
		await interruptedReader.read();
		const pendingRead = interruptedReader.read();
		duringBody.abort(new Error("owned mid-body abort"));
		await assert.rejects(pendingRead);
		interruptedReader.releaseLock();
		await abortClosed;
		const controller = new AbortController();
		controller.abort();
		const beforeAbort = proxyCalls;
		await assert.rejects(fetch(new Request("http://runtime.invalid/echo", { signal: controller.signal })));
		check(proxyCalls === beforeAbort, "Already aborted Request does not connect");
		check(
			(await (await fetch(new Request(direct.url))).text()) === `127.0.0.1:${direct.port}`,
			"Initial loopback Request bypasses proxy",
		);
		if (mode === "native" && process.versions.bun) {
			const beforeRedirect = proxyCalls;
			const nativeRedirect = (await (await fetch(new Request("http://runtime.invalid/bypass"))).json()) as Echo;
			check(
				nativeRedirect.host === `127.0.0.1:${direct.port}` && proxyCalls === beforeRedirect + 2,
				"Match native/curl baseline: explicit proxy carries localhost redirects without NO_PROXY",
			);
		}
		process.env.NO_PROXY = "127.0.0.1";
		check(
			(await (await fetch(new Request("http://runtime.invalid/bypass"))).text()) === `127.0.0.1:${direct.port}`,
			"NO_PROXY applies to redirected Request",
		);
		delete process.env.NO_PROXY;
		if (mode === "host" || !process.versions.bun) {
			check(
				(await (await fetch(new Request("http://runtime.invalid/bypass"))).text()) === `127.0.0.1:${direct.port}`,
				"Undici also applies built-in loopback bypass to redirects",
			);
		}
	});
	let unsafeFetchCalls = 0;
	globalThis.fetch = async () => {
		unsafeFetchCalls++;
		throw new Error("Unsafe global transport");
	};
	const pinned = await fetchRemoteUrl(
		`http://pinned.invalid:${direct.port}/`,
		{},
		{
			allowRanges: ["127.0.0.1/32"],
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		},
	);
	check(
		(await pinned.text()) === `pinned.invalid:${direct.port}` && unsafeFetchCalls === 0,
		"Protected transport pins approved address and original Host independently of globals",
	);
	for (const path of ["truncated", "bad-gzip"]) {
		const failed = await fetchRemoteUrl(
			`http://pinned.invalid:${direct.port}/${path}`,
			{},
			{
				allowRanges: ["127.0.0.1/32"],
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			},
		);
		await assert.rejects(failed.text());
	}
	globalThis.fetch = wrappedFetch;
	if (mode === "host") {
		for (const path of ["truncated", "bad-gzip"])
			await assert.rejects(compatibleFetch(`${direct.url}/${path}`).then((response) => response.text()));
	}
	const geminiFetch = await resolveGeminiFetch();
	const largeHeaders = await geminiFetch(`${direct.url}/headers`);
	check(
		largeHeaders.headers.get("x-large-fixture")?.length === 20_000,
		"Dedicated Gemini transport retains its larger header budget",
	);
	await largeHeaders.text();
	for (const path of ["truncated", "bad-gzip"])
		await assert.rejects(geminiFetch(`${direct.url}/${path}`).then((response) => response.text()));
	await runWithProxy(proxy.url, async () => {
		await assert.rejects(fetchRemoteUrl("http://runtime.invalid/echo"), /ssrf.trustEnvProxy/);
		const trusted = await fetchRemoteUrl(
			"http://runtime.invalid/echo",
			{},
			{
				trustEnvProxy: true,
				lookup: async () => {
					throw new Error("Proxy target must not resolve locally");
				},
			},
		);
		check(
			((await trusted.json()) as Echo).host === "runtime.invalid",
			"Protected explicitly trusted proxy owns target resolution",
		);
	});
	console.log(
		JSON.stringify({
			runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
			mode,
			assertions,
			rootUndici: createRequire(import.meta.url)("undici/package.json").version,
			webUndici: webRequire("undici/package.json").version,
			success: true,
		}),
	);
} finally {
	globalThis.fetch = wrappedFetch;
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				}),
		),
	);
	const currentDispatcher = getGlobalDispatcher();
	if (currentDispatcher !== initialDispatcher) await currentDispatcher.destroy();
}
