import { getEventListeners } from "node:events";
import type * as Http from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import type { AuthEvent, OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";

const ownedServers = vi.hoisted(() => [] as Http.Server[]);
vi.mock("node:http", async (importOriginal) => {
	const http = await importOriginal<typeof Http>();
	return {
		...http,
		createServer: (...args: Parameters<typeof Http.createServer>) => {
			const server = http.createServer(...args);
			ownedServers.push(server);
			return server;
		},
	};
});
const radius = createRadiusOAuth({ name: "Radius", gateway: "https://radius.test" });
beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected fetch");
		}),
	);
});
afterEach(() => {
	for (const server of ownedServers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
	vi.unstubAllGlobals();
});
const providers = [
	{ name: "Anthropic", oauth: anthropicOAuth, port: 53692 },
	{ name: "Codex", oauth: openaiCodexOAuth, port: 1455 },
];
async function assertPortReleased(port: number) {
	const listener = createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(port, "127.0.0.1", resolve);
		});
	} finally {
		await new Promise<void>((resolve) => listener.close(() => resolve()));
	}
}
// These flows use fixed, provider-registered callback ports. Keep this file's tests serial.
describe.each(providers)("$name browser OAuth ownership", ({ oauth, port }) => {
	it.each([false, true])(
		"settles cancellation and aborts its manual prompt (prompt honors abort: %s)",
		async (cooperative) => {
			const controller = new AbortController();
			const fetch = vi.fn(async () => {
				throw new Error("must not exchange tokens");
			});
			vi.stubGlobal("fetch", fetch);
			let promptSignal: AbortSignal | undefined;
			let releasePrompt: (input: string) => void = () => {};
			let opened: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				opened = resolve;
			});
			const login = oauth.login({
				signal: controller.signal,
				notify: () => {},
				prompt: (prompt) => {
					if (prompt.type === "select") return Promise.resolve("browser");
					promptSignal = prompt.signal;
					opened();
					return new Promise<string>((resolve, reject) => {
						releasePrompt = resolve;
						if (cooperative)
							prompt.signal?.addEventListener("abort", () => reject(new Error("prompt cancelled")), {
								once: true,
							});
					});
				},
			});
			const outcome = login.then(
				() => "resolved",
				() => "rejected",
			);
			try {
				await ready;
				controller.abort();
				expect(await Promise.race([outcome, delay(100).then(() => "pending")])).toBe("rejected");
				expect(promptSignal?.aborted).toBe(true);
				expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
				await assertPortReleased(port);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				releasePrompt("");
				await outcome;
			}
		},
	);
	it("closes the callback server when auth_url notification throws", async () => {
		await expect(
			oauth.login({
				signal: new AbortController().signal,
				prompt: async () => "browser",
				notify: () => {
					throw new Error("notification failed");
				},
			}),
		).rejects.toThrow("notification failed");
		await assertPortReleased(port);
	});
	it("does not prompt on pre-abort", async () => {
		const prompt = vi.fn(async () => "browser");
		await expect(oauth.login({ signal: AbortSignal.abort(), prompt, notify: () => {} })).rejects.toThrow();
		expect(prompt).not.toHaveBeenCalled();
		await assertPortReleased(port);
	});
});

describe("Radius browser OAuth ownership", () => {
	const discovery = () => new Response(JSON.stringify({ authorizationEndpoint: "https://radius.test/authorize" }));
	it.each(["progress", "auth_url"])("closes the callback server when %s notification throws", async (type) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => discovery()),
		);
		const controller = new AbortController();
		await expect(
			radius.login({
				signal: controller.signal,
				prompt: async () => "browser",
				notify: (event) => {
					if (event.type === type) throw new Error("notification failed");
				},
			}),
		).rejects.toThrow("notification failed");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		await assertPortReleased(1456);
	});
	it("does not prompt or discover on pre-abort", async () => {
		const prompt = vi.fn(async () => "browser");
		await expect(radius.login({ signal: AbortSignal.abort(), prompt, notify: () => {} })).rejects.toThrow();
		expect(prompt).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not acquire a callback server after cancellation during discovery", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				controller.abort();
				return discovery();
			}),
		);
		const notify = vi.fn();
		const outcome = radius.login({ signal: controller.signal, prompt: async () => "browser", notify }).then(
			() => "resolved",
			() => "rejected",
		);
		expect(await Promise.race([outcome, delay(100).then(() => "pending")])).toBe("rejected");
		expect(notify).not.toHaveBeenCalled();
		expect(ownedServers).toHaveLength(0);
		await assertPortReleased(1456);
	});
});

const token = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.sig`;
const validToken = { access_token: token, refresh_token: "new-refresh", expires_in: 3600 };
const malformed: unknown[] = [
	null,
	{},
	[],
	{ ...validToken, access_token: "" },
	{ ...validToken, access_token: 123 },
	{ ...validToken, refresh_token: " " },
	{ ...validToken, expires_in: "3600" },
	{ ...validToken, expires_in: 0 },
	{ ...validToken, expires_in: -1 },
	{ ...validToken, expires_in: 1e308 },
	{ ...validToken, scope: {} },
];
function setup(oauth: OAuthAuth, credentials: InMemoryCredentialStore) {
	const neverStream = () => {
		throw new Error("must not stream");
	};
	const models = createModels({ credentials });
	models.setProvider(
		createProvider({
			id: "test",
			models: [],
			auth: { oauth },
			api: { stream: neverStream, streamSimple: neverStream },
		}),
	);
	return models;
}
describe.each([
	{ name: "Anthropic", oauth: anthropicOAuth },
	{ name: "Radius", oauth: radius },
	{ name: "Codex", oauth: openaiCodexOAuth },
])("$name refresh validation", ({ oauth }) => {
	it.each(malformed.map((data, index) => ({ data, index })))(
		"preserves stored credentials for malformed response $index",
		async ({ data }) => {
			const credentials = new InMemoryCredentialStore();
			const old: OAuthCredential = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 };
			await credentials.modify("test", async () => old);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(JSON.stringify(data))),
			);
			await expect(setup(oauth, credentials).getAuth("test")).rejects.toThrow();
			expect(await credentials.read("test")).toEqual(old);
		},
	);
	it.each([
		{ ...validToken, refresh_token: { secret: "not-a-string" } },
		{ ...validToken, expires_in: "3600" },
	])("rejects malformed successful login token exchanges (%#)", async (data) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				if (String(input).endsWith("/v1/oauth/device")) {
					return new Response(
						JSON.stringify({
							device_code: "device",
							user_code: "user",
							verification_uri: "https://radius.test/pair",
							expires_in: 600,
						}),
					);
				}
				return new Response(JSON.stringify(data));
			}),
		);
		await expect(
			oauth.login({
				signal: new AbortController().signal,
				notify: () => {},
				prompt: async (prompt) =>
					prompt.type === "select" ? (oauth === radius ? "device-code" : "browser") : "authorization-code",
			}),
		).rejects.toThrow("invalid token fields");
	});
	it("persists a valid refresh", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("test", async () => ({
			type: "oauth",
			access: "old",
			refresh: "old-refresh",
			expires: 0,
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(validToken))),
		);
		expect((await setup(oauth, credentials).getAuth("test"))?.auth.apiKey).toBe(token);
		expect(await credentials.read("test")).toMatchObject({ access: token, refresh: "new-refresh" });
	});
});

/** Hold a fixed callback port the way a foreign process would. */
async function occupyPort(port: number): Promise<() => Promise<void>> {
	const blocker = createServer();
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject);
		blocker.listen(port, "127.0.0.1", resolve);
	});
	return async () => {
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
	};
}

describe("busy OAuth callback ports", () => {
	it("reports the Codex bind failure and still finishes through a pasted code", async () => {
		const release = await occupyPort(1455);
		try {
			const events: AuthEvent[] = [];
			const fetchMock = vi.fn(async (input: unknown) => {
				expect(String(input)).toBe("https://auth.openai.com/oauth/token");
				return new Response(JSON.stringify(validToken));
			});
			vi.stubGlobal("fetch", fetchMock);

			const credential = await openaiCodexOAuth.login({
				signal: new AbortController().signal,
				notify: (event) => events.push(event),
				prompt: async (prompt) => (prompt.type === "select" ? "browser" : "authorization-code"),
			});

			expect(credential).toMatchObject({ access: token, refresh: "new-refresh" });
			expect(events).toContainEqual({
				type: "info",
				message: expect.stringContaining(
					"Could not start the OAuth callback server on http://localhost:1455/auth/callback: listen EADDRINUSE",
				),
			});
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			await release();
		}
	});

	it("fails the Codex login with the bind failure when no code is pasted", async () => {
		const release = await occupyPort(1455);
		try {
			const fetchMock = vi.fn(async () => {
				throw new Error("must not exchange tokens");
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				openaiCodexOAuth.login({
					signal: new AbortController().signal,
					notify: () => {},
					prompt: async (prompt) => (prompt.type === "select" ? "browser" : ""),
				}),
			).rejects.toThrow(
				/^Could not start the OAuth callback server on http:\/\/localhost:1455\/auth\/callback: .*EADDRINUSE/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await release();
		}
	});

	it("fails the Radius browser login with the bind failure", async () => {
		const release = await occupyPort(1456);
		try {
			const fetchMock = vi.fn(
				async () => new Response(JSON.stringify({ authorizationEndpoint: "https://radius.test/authorize" })),
			);
			vi.stubGlobal("fetch", fetchMock);
			const notify = vi.fn();
			const controller = new AbortController();

			await expect(
				radius.login({ signal: controller.signal, prompt: async () => "browser", notify }),
			).rejects.toThrow(
				/^Could not start the OAuth callback server on http:\/\/127\.0\.0\.1:1456\/oauth\/callback: .*EADDRINUSE/,
			);
			expect(notify).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		} finally {
			await release();
		}
	});
});
