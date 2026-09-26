import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";

const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const MODELS_URL = "https://api.individual.githubcopilot.com/models";
const ROTATED_TOKEN = "tid=1;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function tokenResponse(): Response {
	return new Response(JSON.stringify({ token: ROTATED_TOKEN, expires_at: expiresAtSeconds }), {
		headers: { "content-type": "application/json" },
	});
}

function catalogResponse(ids: string[]): Response {
	return new Response(
		JSON.stringify({
			data: ids.map((id) => ({ id, model_picker_enabled: true, policy: { state: "enabled" } })),
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

/** Throws like fetch does when the request signal is already aborted. */
function throwIfAborted(init?: RequestInit): void {
	if (!init?.signal?.aborted) return;
	throw new DOMException("This operation was aborted", "AbortError");
}

function modelsWithCredential(credentials: InMemoryCredentialStore) {
	const neverStream = () => {
		throw new Error("must not stream");
	};
	const models = createModels({ credentials });
	models.setProvider(
		createProvider({
			id: "github-copilot",
			models: [],
			auth: { oauth: githubCopilotOAuth },
			api: { stream: neverStream, streamSimple: neverStream },
		}),
	);
	return models;
}

const stored: OAuthCredential = {
	type: "oauth",
	access: "old-access",
	refresh: "old-refresh",
	expires: 0,
	availableModelIds: ["stored-model"],
};

describe("GitHub Copilot OAuth refresh", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the rotated token and the last model list when the catalog is rate limited", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			throwIfAborted(init);
			const url = requestUrl(input);
			if (url === TOKEN_URL) return tokenResponse();
			if (url === MODELS_URL) return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(githubCopilotOAuth.refresh(stored, new AbortController().signal)).resolves.toEqual({
			type: "oauth",
			access: ROTATED_TOKEN,
			refresh: "old-refresh",
			expires: expiresAtSeconds * 1000 - 5 * 60 * 1000,
			availableModelIds: ["stored-model"],
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("resolves auth and persists the rotated token when the catalog is unavailable", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("github-copilot", async () => stored);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				throwIfAborted(init);
				const url = requestUrl(input);
				if (url === TOKEN_URL) return tokenResponse();
				if (url === MODELS_URL) throw new Error("network down");
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		const auth = await modelsWithCredential(credentials).getAuth("github-copilot");
		expect(auth?.auth).toEqual({ apiKey: ROTATED_TOKEN, baseUrl: "https://api.individual.githubcopilot.com" });
		expect(await credentials.read("github-copilot")).toMatchObject({
			access: ROTATED_TOKEN,
			refresh: "old-refresh",
			availableModelIds: ["stored-model"],
		});
	});

	it("replaces the model list when the catalog responds", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (url === TOKEN_URL) return tokenResponse();
				if (url === MODELS_URL) return catalogResponse(["fresh-model"]);
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		await expect(githubCopilotOAuth.refresh(stored, new AbortController().signal)).resolves.toMatchObject({
			access: ROTATED_TOKEN,
			availableModelIds: ["fresh-model"],
		});
	});

	it("omits the model list when the catalog fails and none was stored", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = requestUrl(input);
				if (url === TOKEN_URL) return tokenResponse();
				if (url === MODELS_URL) return new Response("nope", { status: 500, statusText: "Server Error" });
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		const { type, access, refresh, expires, enterpriseUrl, ...rest } = await githubCopilotOAuth.refresh(
			{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
			new AbortController().signal,
		);
		expect(access).toBe(ROTATED_TOKEN);
		expect(refresh).toBe("old-refresh");
		expect(rest).toEqual({});
		expect(type).toBe("oauth");
		expect(expires).toBe(expiresAtSeconds * 1000 - 5 * 60 * 1000);
		expect(enterpriseUrl).toBeUndefined();
	});

	it("propagates abort during the catalog fetch", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const url = requestUrl(input);
				if (url === TOKEN_URL) {
					controller.abort();
					return tokenResponse();
				}
				throwIfAborted(init);
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		await expect(githubCopilotOAuth.refresh(stored, controller.signal)).rejects.toThrow(/aborted/i);
	});
});
