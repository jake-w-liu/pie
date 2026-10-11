import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	FetchFunction,
	Model,
	OAuthAuth,
	Provider,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

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

describe("ModelRuntime OAuth 401 retry", () => {
	it("refreshes a rejected token through the runtime stream path and retries once", async () => {
		const credentials = AuthStorage.inMemory({
			[PROVIDER_ID]: {
				type: "oauth",
				access: "old-token",
				refresh: "r",
				expires: Date.now() + 3_600_000,
			},
		});
		const runtime = getModelRuntime(await createInMemoryModelRegistry(credentials));

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
		const runRequest = (
			requestOptions: (StreamOptions | SimpleStreamOptions) | undefined,
		): AssistantMessageEventStream => {
			const stream = createAssistantMessageEventStream();
			const run = async () => {
				const response = await (requestOptions?.fetch ?? globalThis.fetch)("https://test.invalid/v1", {
					headers: { authorization: `Bearer ${requestOptions?.apiKey}` },
				});
				if (!response.ok) {
					stream.push({ type: "start", partial: assistantMessage("") });
					stream.push({
						type: "error",
						reason: "error",
						error: { ...assistantMessage(""), stopReason: "error", errorMessage: `HTTP ${response.status}` },
					});
					return;
				}
				const message = assistantMessage("ok");
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			};
			run().catch((error: unknown) => {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...assistantMessage(""),
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					},
				});
			});
			return stream;
		};

		const provider: Provider = {
			id: PROVIDER_ID,
			name: PROVIDER_ID,
			auth: { oauth },
			getModels: () => [model],
			stream: (_requestModel, _context, requestOptions) => runRequest(requestOptions),
			streamSimple: (_requestModel, _context, requestOptions) => runRequest(requestOptions),
		};
		runtime.registerNativeProvider(provider);

		const baseFetch: FetchFunction = async (_input, init) => {
			const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			requests.push(authorization);
			const token = authorization?.replace("Bearer ", "");
			return new Response(token === "new-token" ? "ok" : "expired", {
				status: token === "new-token" ? 200 : 401,
			});
		};

		const events: AssistantMessageEvent[] = [];
		for await (const event of runtime.stream(model, context, { fetch: baseFetch })) {
			events.push(event);
		}

		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(requests).toEqual(["Bearer old-token", "Bearer new-token"]);
		expect(await credentials.read(PROVIDER_ID)).toMatchObject({ type: "oauth", access: "new-token" });
	});
});
