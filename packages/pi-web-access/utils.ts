import { AsyncLocalStorage } from "node:async_hooks";
import { fetchWithResponseErrors } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
// Select the pinned npm transport, not Bun's bare-specifier compatibility shim.
import { Agent, Pool, ProxyAgent, Request as UndiciRequest, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici/index.js";
import { join } from "node:path";

export function getWebSearchConfigDir(): string {
	if (process.env.PIE_CODING_AGENT_DIR) return process.env.PIE_CODING_AGENT_DIR;
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
	return join(homedir(), ".pi");
}

export function getWebSearchConfigPath(): string {
	return join(getWebSearchConfigDir(), "web-search.json");
}

interface ApiBaseUrlOptions {
	configKey: string;
	configuredValue: unknown;
	defaultValue: string;
	environmentKey: string;
	environmentValue: string | undefined;
}

export function resolveApiBaseUrl(options: ApiBaseUrlOptions): string {
	const fromEnvironment = options.environmentValue !== undefined;
	const value = fromEnvironment ? options.environmentValue : options.configuredValue;
	if (value === undefined) return options.defaultValue;

	const source = fromEnvironment
		? options.environmentKey
		: `${options.configKey} in ${getWebSearchConfigPath()}`;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${source} must be an absolute HTTP(S) URL`);
	}

	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`${source} must be an absolute HTTP(S) URL`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`${source} must be an absolute HTTPS URL`);
	}
	if (url.username || url.password) {
		throw new Error(`${source} must not include credentials`);
	}
	if (url.search || url.hash) {
		throw new Error(`${source} must not include query parameters or fragments`);
	}

	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/+$/, "");
}

const API_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const API_REQUEST_BODY_HEADERS = ["Content-Encoding", "Content-Language", "Content-Location", "Content-Type"];
const MAX_API_REDIRECTS = 5;

export async function fetchWithCredentialRedirects(
	url: string,
	init: RequestInit,
	credentialHeaders: readonly string[],
): Promise<Response> {
	let current = new URL(url);
	let requestInit = init;

	for (let redirects = 0; ; redirects++) {
		const response = await fetch(current, { ...requestInit, redirect: "manual" });
		if (!API_REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		await response.body?.cancel();
		if (redirects === MAX_API_REDIRECTS) {
			throw new Error(`Too many API redirects from ${url}`);
		}

		const next = new URL(location, current);
		if (next.protocol !== "http:" && next.protocol !== "https:") {
			throw new Error(`API redirect from ${current.origin} must use HTTP(S)`);
		}
		const method = requestInit.method?.toUpperCase() ?? "GET";
		if (
			((response.status === 301 || response.status === 302) && method === "POST")
			|| (response.status === 303 && method !== "GET" && method !== "HEAD")
		) {
			const headers = new Headers(requestInit.headers);
			for (const name of API_REQUEST_BODY_HEADERS) headers.delete(name);
			const { body: _body, ...withoutBody } = requestInit;
			requestInit = { ...withoutBody, method: "GET", headers };
		}
		if (next.origin !== current.origin) {
			const headers = new Headers(requestInit.headers);
			for (const name of credentialHeaders) headers.delete(name);
			requestInit = { ...requestInit, headers };
		}
		current = next;
	}
}

export interface CuratorNetworkConfig {
	/** Whether remote access was opted into via curatorRemote. */
	enabled: boolean;
	host: string;
	bind: string;
}

const LOCAL_CURATOR_NETWORK_DEFAULTS: CuratorNetworkConfig = { enabled: false, host: "localhost", bind: "127.0.0.1" };

function trimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Resolves the curator server bind address and URL host from `curatorRemote`. */
export function resolveCuratorNetworkConfig(): CuratorNetworkConfig {
	const configPath = getWebSearchConfigPath();
	if (!existsSync(configPath)) return LOCAL_CURATOR_NETWORK_DEFAULTS;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return LOCAL_CURATOR_NETWORK_DEFAULTS;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return LOCAL_CURATOR_NETWORK_DEFAULTS;

	const curatorRemote = (raw as Record<string, unknown>).curatorRemote;
	if (curatorRemote === true) return { enabled: true, host: hostname(), bind: "0.0.0.0" };

	if (curatorRemote && typeof curatorRemote === "object" && !Array.isArray(curatorRemote)) {
		const obj = curatorRemote as Record<string, unknown>;
		return {
			enabled: true,
			host: trimmedString(obj.host) ?? hostname(),
			// Default to loopback: LAN exposure requires an explicit bind.
			bind: trimmedString(obj.bind) ?? "127.0.0.1",
		};
	}

	return LOCAL_CURATOR_NETWORK_DEFAULTS;
}

export function formatSeconds(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

export function readExecError(err: unknown): { code?: string; stderr: string; message: string } {
	if (!err || typeof err !== "object") {
		return { stderr: "", message: String(err) };
	}
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	const stderrRaw = (err as { stderr?: Buffer | string }).stderr;
	const stderr = Buffer.isBuffer(stderrRaw)
		? stderrRaw.toString("utf-8")
		: typeof stderrRaw === "string"
			? stderrRaw
			: "";
	return { code, stderr, message };
}

export function isTimeoutError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	if ((err as { killed?: boolean }).killed) return true;
	const name = (err as { name?: string }).name;
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	return name === "AbortError" || code === "ETIMEDOUT" || message.toLowerCase().includes("timed out");
}

export function trimErrorText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function mapFfmpegError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffmpeg is not installed. Install with: brew install ffmpeg";
	if (isTimeoutError(err)) return "ffmpeg timed out extracting frame";
	if (stderr.includes("403")) return "Stream URL returned 403 — may have expired, try again";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffmpeg failed: ${snippet}` : "ffmpeg failed";
}

const proxyStorage = new AsyncLocalStorage<string | null>();

export function normalizeProxyUrl(value: unknown, source: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error(`${source} must be an http(s) proxy URL string`);
	const trimmed = value.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${source} must be a valid proxy URL: ${JSON.stringify(trimmed)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${source} must use the http:// or https:// scheme: ${trimmed}`);
	}
	if (!parsed.hostname) throw new Error(`${source} must include a proxy host: ${trimmed}`);
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString();
}

function loadConfiguredProxy(): string | null {
	let configured: unknown;
	const path = getWebSearchConfigPath();
	if (existsSync(path)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to load proxy config from ${path}: ${message}`);
		}
		if (raw && typeof raw === "object" && !Array.isArray(raw)) configured = (raw as { proxy?: unknown }).proxy;
	}
	if (configured === undefined) return null;
	return normalizeProxyUrl(configured, `proxy in ${getWebSearchConfigPath()}`);
}

export function runWithProxy<T>(proxy: string | undefined, fn: () => T): T {
	if (proxy === undefined) return fn();
	const normalized = normalizeProxyUrl(proxy, "proxy");
	return proxyStorage.run(normalized, fn);
}

export function getActiveProxy(): string | null {
	const scoped = proxyStorage.getStore();
	return scoped !== undefined ? scoped : loadConfiguredProxy();
}

export function hasScopedProxyDecision(): boolean {
	return proxyStorage.getStore() !== undefined;
}

function noProxyEntryMatches(url: URL, entry: string): boolean {
	if (!entry) return false;
	if (entry === "*") return true;
	let host = entry;
	let port: string | undefined;
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close > 0) {
			if (/^:\d+$/.test(host.slice(close + 1))) port = host.slice(close + 2);
			host = host.slice(0, close + 1);
		}
	} else {
		const colon = host.lastIndexOf(":");
		if (colon > -1 && /^\d+$/.test(host.slice(colon + 1))) {
			port = host.slice(colon + 1);
			host = host.slice(0, colon);
		}
	}
	if (port && port !== (url.port || (url.protocol === "https:" ? "443" : "80"))) return false;
	host = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "").replace(/^\*\./, ".");
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	return Boolean(host) && (hostname === host.replace(/^\./, "") || hostname.endsWith(host.startsWith(".") ? host : `.${host}`));
}

/** True when a URL must NOT be sent through the active proxy. */
export function isProxyBypassedUrl(url: URL): boolean {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1") return true;
	const noProxy = process.env.NO_PROXY || process.env.no_proxy;
	return Boolean(noProxy?.split(",").some(entry => noProxyEntryMatches(url, entry.trim())));
}

/** One proxy decision shared by validation and transport, including explicit direct overrides. */
export function getProxyForUrl(url: URL, explicit?: string): string | null {
	const selected = explicit !== undefined ? normalizeProxyUrl(explicit, "proxy") : getActiveProxy();
	if (isProxyBypassedUrl(url)) return null;
	if (explicit !== undefined || hasScopedProxyDecision() || selected) return selected;
	const candidates = url.protocol === "https:"
		? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy]
		: [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy];
	for (const candidate of candidates) {
		if (candidate?.trim()) return normalizeProxyUrl(candidate, "environment proxy");
	}
	return null;
}

export interface ProxiedRequestInit extends RequestInit {
	/** Caller-supplied proxy; bypasses AsyncLocalStorage for pLimit-safe contexts. */
	__proxy?: string;
}

interface ProxiedFetch {
	(input: RequestInfo | URL, init?: ProxiedRequestInit): Promise<Response>;
	__piWebAccessProxyFetch?: boolean;
}

/**
 * Uses the imported transport, never a possibly dispatcher-ignoring global fetch.
 * Each dispatcher is request-owned; close drains the streaming response, including cancellation.
 */
export async function fetchWithDispatcher(url: string | URL | UndiciRequest, init: RequestInit, dispatcher: Dispatcher): Promise<Response> {
	try {
		const signal = init.signal !== undefined ? init.signal : typeof url === "string" || url instanceof URL ? undefined : url.signal;
		const response = await fetchWithResponseErrors(dispatcher, async (observed) =>
			await undiciFetch(url, { ...init, dispatcher: observed } as UndiciRequestInit) as Response, signal);
		// close is nonblocking until this response ends/cancels; no body buffering or tee.
		void dispatcher.close();
		return response as Response;
	} catch (error) {
		await dispatcher.destroy();
		throw error;
	}
}

/** Wrap global fetch only for configured/scoped proxies; provider calls are not SSRF-gated. */
export function installGlobalProxyFetch(): void {
	const current = globalThis.fetch as ProxiedFetch;
	if (typeof current !== "function" || current.__piWebAccessProxyFetch === true) return;
	const wrapped: ProxiedFetch = async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const proxy = init?.__proxy !== undefined ? normalizeProxyUrl(init.__proxy, "proxy") : getActiveProxy();
		const hasDecision = init?.__proxy !== undefined || hasScopedProxyDecision() || proxy !== null;
		if (!hasDecision || (url.protocol !== "http:" && url.protocol !== "https:")) return current(input, init);
		const dispatcher = new Agent({
			// Fetch handles redirects and credentials; transport rechecks bypass on every origin.
			// A direct decision must not fall through to the host's environment proxy dispatcher.
			factory: origin => !proxy || isProxyBypassedUrl(new URL(origin)) ? new Pool(origin) : new ProxyAgent(proxy),
		});
		if (typeof input === "string" || input instanceof URL || input instanceof UndiciRequest) {
			return fetchWithDispatcher(input, init ?? {}, dispatcher);
		}
		try {
			// Preserve the original Request's opaque replayable body and keepalive
			// metadata through its compatible captured fetch, including different npm
			// Undici versions. Native Bun honors proxy; npm/Node honor dispatcher.
			// Supplying both avoids guessing which implementation the host installed.
			const signal = init?.signal !== undefined ? init.signal : input.signal;
			const response = await fetchWithResponseErrors(dispatcher, (observed) => {
				const requestInit = { ...init, dispatcher: observed, proxy: proxy && !isProxyBypassedUrl(url) ? proxy : "" };
				return current(input, requestInit);
			}, signal);
			void dispatcher.close();
			return response;
		} catch (error) {
			await dispatcher.destroy();
			throw error;
		}
	};
	wrapped.__piWebAccessProxyFetch = true;
	globalThis.fetch = wrapped;
}
