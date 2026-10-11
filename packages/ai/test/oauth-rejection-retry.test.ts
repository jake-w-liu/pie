import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { OAuthAuth } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchFunction,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const PROVIDER_ID = "oauth-test";

const model: Model<Api> = {
	id: "oauth-model",
	name: "oauth-model",
	api: "test-api",
	provider: PROVIDER_ID,
	baseUrl: "https://test.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function errorMessage(text: string): AssistantMessage {
	return { ...assistantMessage(""), stopReason: "error", errorMessage: text };
}

const freshCredential = {
	type: "oauth",
	access: "old-token",
	refresh: "r",
	expires: Date.now() + 3_600_000,
} as const;

function createHarness(options?: {
	respond?: (token: string | undefined) => Response | Promise<Response>;
	emitTextBeforeRequest?: boolean;
}) {
	const credentials = new InMemoryCredentialStore();
	const refresh = vi.fn(async (current: Parameters<OAuthAuth["refresh"]>[0]) => ({
		...current,
		access: "new-token",
		expires: Date.now() + 3_600_000,
	}));
	const oauth: OAuthAuth = {
		name: "Test OAuth",
		login: async () => {
			throw new Error("not used");
		},
		refresh,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};

	const requests: Array<string | undefined> = [];
	const respond = options?.respond ?? (() => new Response("ok", { status: 200 }));
	const baseFetch: FetchFunction = async (_input, init) => {
		const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
		requests.push(authorization);
		return respond(authorization?.replace("Bearer ", ""));
	};

	const emitTextBeforeRequest = options?.emitTextBeforeRequest ?? false;
	const runRequest = (
		requestOptions: (StreamOptions | SimpleStreamOptions) | undefined,
	): AssistantMessageEventStream => {
		const stream = new AssistantMessageEventStream();
		const partial = assistantMessage("partial");
		const run = async () => {
			if (emitTextBeforeRequest) {
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
			}
			const response = await (requestOptions?.fetch ?? globalThis.fetch)("https://test.invalid/v1", {
				headers: { authorization: `Bearer ${requestOptions?.apiKey}` },
			});
			if (!response.ok) {
				if (!emitTextBeforeRequest) stream.push({ type: "start", partial: assistantMessage("") });
				stream.push({
					type: "error",
					reason: "error",
					error: errorMessage(`HTTP ${response.status}`),
				});
				return;
			}
			const message = assistantMessage("ok");
			if (!emitTextBeforeRequest) stream.push({ type: "start", partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		};
		run().catch((error: unknown) => {
			stream.push({
				type: "error",
				reason: "error",
				error: errorMessage(error instanceof Error ? error.message : String(error)),
			});
		});
		return stream;
	};

	const api: ProviderStreams = {
		stream: (_requestModel, _context, requestOptions) => runRequest(requestOptions),
		streamSimple: (_requestModel, _context, requestOptions) => runRequest(requestOptions),
	};

	const provider = createProvider({
		id: PROVIDER_ID,
		auth: { oauth },
		models: [model],
		api,
	});
	const models = createModels({ credentials });
	models.setProvider(provider);

	return { credentials, models, refresh, requests, baseFetch };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

async function storeCredential(credentials: InMemoryCredentialStore): Promise<void> {
	await credentials.modify(PROVIDER_ID, async () => ({ ...freshCredential }));
}

describe("OAuth 401 refresh and retry", () => {
	it("refreshes a fresh-by-expiry token rejected with 401 and retries once", async () => {
		const { credentials, models, refresh, requests, baseFetch } = createHarness({
			respond: (token) =>
				new Response(token === "new-token" ? "ok" : "expired", {
					status: token === "new-token" ? 200 : 401,
				}),
		});
		await storeCredential(credentials);

		const events = await collect(models.stream(model, context, { fetch: baseFetch }));
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "new-token" });
		expect(requests).toEqual(["Bearer old-token", "Bearer new-token"]);
	});

	it("does not retry the retry when both attempts are rejected", async () => {
		const { credentials, models, refresh, requests, baseFetch } = createHarness({
			respond: () => new Response("expired", { status: 401 }),
		});
		await storeCredential(credentials);

		const events = await collect(models.stream(model, context, { fetch: baseFetch }));
		expect(events.at(-1)?.type).toBe("error");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(requests).toEqual(["Bearer old-token", "Bearer new-token"]);
	});

	it("does not retry when events were emitted before the 401", async () => {
		const { credentials, models, refresh, requests, baseFetch } = createHarness({
			emitTextBeforeRequest: true,
			respond: () => new Response("expired", { status: 401 }),
		});
		await storeCredential(credentials);

		const events = await collect(models.stream(model, context, { fetch: baseFetch }));
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
		expect(refresh).not.toHaveBeenCalled();
		expect(requests).toEqual(["Bearer old-token"]);
	});

	it("does not retry a non-401 error", async () => {
		const { credentials, models, refresh, requests, baseFetch } = createHarness({
			respond: () => new Response("server error", { status: 500 }),
		});
		await storeCredential(credentials);

		const events = await collect(models.stream(model, context, { fetch: baseFetch }));
		expect(events.at(-1)?.type).toBe("error");
		expect(refresh).not.toHaveBeenCalled();
		expect(requests).toEqual(["Bearer old-token"]);
	});

	it("does not retry when an explicit apiKey bypasses the stored credential", async () => {
		const { credentials, models, refresh, requests, baseFetch } = createHarness({
			respond: () => new Response("expired", { status: 401 }),
		});
		await storeCredential(credentials);

		const events = await collect(models.stream(model, context, { apiKey: "old-token", fetch: baseFetch }));
		expect(events.at(-1)?.type).toBe("error");
		expect(refresh).not.toHaveBeenCalled();
		expect(requests).toEqual(["Bearer old-token"]);
	});

	it("does not refresh when another request already rotated the token", async () => {
		const { credentials, models, refresh, requests } = createHarness();
		await storeCredential(credentials);
		const rotatingFetch: FetchFunction = async (_input, init) => {
			const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			requests.push(authorization);
			const token = authorization?.replace("Bearer ", "");
			if (token === "old-token") {
				// A concurrent request rotated the stored credential after its own refresh.
				await credentials.modify(PROVIDER_ID, async (current) =>
					current?.type === "oauth" ? { ...current, access: "rotated-token" } : current,
				);
				return new Response("expired", { status: 401 });
			}
			return new Response("ok", { status: 200 });
		};

		const events = await collect(models.stream(model, context, { fetch: rotatingFetch }));
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(refresh).not.toHaveBeenCalled();
		expect(requests).toEqual(["Bearer old-token", "Bearer rotated-token"]);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "rotated-token" });
	});

	it("does not retry when the request signal aborted before the 401", async () => {
		const { credentials, models, refresh, requests } = createHarness();
		await storeCredential(credentials);
		const controller = new AbortController();
		const abortingFetch: FetchFunction = async (_input, init) => {
			const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			requests.push(authorization);
			controller.abort();
			return new Response("expired", { status: 401 });
		};

		const events = await collect(models.stream(model, context, { fetch: abortingFetch, signal: controller.signal }));
		expect(events.at(-1)?.type).toBe("error");
		expect(refresh).not.toHaveBeenCalled();
		expect(requests).toEqual(["Bearer old-token"]);
	});

	it("retries streamSimple the same way", async () => {
		const { credentials, models, refresh, requests, baseFetch } = createHarness({
			respond: (token) =>
				new Response(token === "new-token" ? "ok" : "expired", {
					status: token === "new-token" ? 200 : 401,
				}),
		});
		await storeCredential(credentials);

		const events = await collect(models.streamSimple(model, context, { fetch: baseFetch }));
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(requests).toEqual(["Bearer old-token", "Bearer new-token"]);
	});
});

describe("rejectedOAuthAccess auth resolution", () => {
	it("refreshes a fresh credential still holding the rejected token", async () => {
		const { credentials, models, refresh } = createHarness();
		await storeCredential(credentials);

		const resolution = await models.getAuth(model, { rejectedOAuthAccess: "old-token" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(resolution?.oauthAccess).toBe("new-token");
	});

	it("leaves a credential holding a different access token alone", async () => {
		const { credentials, models, refresh } = createHarness();
		await storeCredential(credentials);

		const resolution = await models.getAuth(model, { rejectedOAuthAccess: "other-token" });
		expect(refresh).not.toHaveBeenCalled();
		expect(resolution?.oauthAccess).toBe("old-token");
	});
});
