import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { isCredentialFresh } from "../src/auth/resolve.ts";
import type { Credential, CredentialStore, OAuthCredential, ProviderAuth } from "../src/auth/types.ts";

const SECRET = "sk-kimi-AAAABBBBCCCCDDDD-secret-value";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("oauth token responses are never echoed into error messages", () => {
	it("kimi refresh failure does not leak the access token from a partial response", async () => {
		const fetchMock = vi.fn(async () =>
			// access_token is present and valid; the sibling fields are not. The raw
			// body is a usable credential, so it must not reach the message.
			jsonResponse({ access_token: SECRET, token_type: "Bearer", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const stored: OAuthCredential = {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() - 1000,
		};
		const store = new InMemoryCredentialStore();
		await store.modify("kimi-coding", async () => stored);

		const oauth = kimiCodingOAuth;
		await expect(oauth.refresh(stored, new AbortController().signal)).rejects.toThrow(/missing required fields/);
		await oauth.refresh(stored, new AbortController().signal).catch((error: unknown) => {
			expect(String((error as Error).message)).not.toContain(SECRET);
		});
	});

	it("kimi device authorization failure does not echo the response body", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ device_code: "dc-1", user_code: "UC-1" }, 200));
		vi.stubGlobal("fetch", fetchMock);

		const oauth = kimiCodingOAuth;
		const prompts: string[] = [];
		const interaction = {
			signal: new AbortController().signal,
			prompt: async (p: { message: string }) => {
				prompts.push(p.message);
				return "1";
			},
			notify: () => {},
		};
		await expect(oauth.login(interaction)).rejects.toThrow(/device authorization response/);
		await kimiCodingOAuth.login(interaction).catch((error: unknown) => {
			expect(String((error as Error).message)).not.toContain("dc-1");
		});
		expect(fetchMock).toHaveBeenCalled();
		expect(getUrl((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0])).toContain("auth.kimi.com");
	});
});

describe("isCredentialFresh", () => {
	it("treats an evaluable future expiry as fresh", () => {
		expect(
			isCredentialFresh({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 600_000 }, 300_000),
		).toBe(true);
	});

	it("treats a past expiry as not fresh", () => {
		expect(isCredentialFresh({ type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1 }, 0)).toBe(false);
	});

	it("fails closed for an expiry that cannot be evaluated", () => {
		// A hand-edited, migrated, or partially written credential file yields
		// undefined/null/NaN. The plain relational comparison is false for all of
		// them, which would disable refresh permanently.
		for (const expires of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
			const credential = { type: "oauth", access: "a", refresh: "r", expires } as unknown as OAuthCredential;
			expect(isCredentialFresh(credential, 0)).toBe(false);
		}
	});
});

describe("explicit apiKey override keeps a stored credential's env", () => {
	async function seededStore(credential: Credential): Promise<CredentialStore> {
		const store = new InMemoryCredentialStore();
		await store.modify("p1", async () => credential);
		return store;
	}

	it("merges the stored env so a provider-scoped value survives the override", async () => {
		const auth: ProviderAuth = {
			apiKey: {
				name: "test-api-key",
				resolve: ({ credential }) =>
					Promise.resolve({
						auth: { apiKey: credential?.key ?? "" },
						env: credential?.env ?? {},
					}),
			},
		};
		const { resolveProviderAuth } = await import("../src/auth/resolve.ts");
		const authContext = { env: async () => undefined, fileExists: async () => false };

		const store = await seededStore({
			type: "api_key",
			key: "stored-key",
			env: { ACCOUNT_ID: "acct-123", GATEWAY_ID: "gw-456" },
		});
		const result = await resolveProviderAuth({ id: "p1", auth }, store, authContext, { apiKey: "explicit-key" });

		expect(result?.auth.apiKey).toBe("explicit-key");
		// Without the merge this is {} and provider-scoped lookups resolve to undefined.
		expect(result?.env).toEqual({ ACCOUNT_ID: "acct-123", GATEWAY_ID: "gw-456" });
	});

	it("lets an explicit env override the stored value", async () => {
		const auth: ProviderAuth = {
			apiKey: {
				name: "test-api-key",
				resolve: ({ credential }) =>
					Promise.resolve({
						auth: { apiKey: credential?.key ?? "" },
						env: credential?.env ?? {},
					}),
			},
		};
		const { resolveProviderAuth } = await import("../src/auth/resolve.ts");
		const authContext = { env: async () => undefined, fileExists: async () => false };

		const store = await seededStore({ type: "api_key", key: "stored-key", env: { ACCOUNT_ID: "acct-123" } });
		const result = await resolveProviderAuth({ id: "p1", auth }, store, authContext, {
			apiKey: "explicit-key",
			env: { ACCOUNT_ID: "acct-override" },
		});

		expect(result?.env).toEqual({ ACCOUNT_ID: "acct-override" });
	});
});
