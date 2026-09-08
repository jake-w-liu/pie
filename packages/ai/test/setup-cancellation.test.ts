import { expect, it, vi } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { Api, Model, ProviderStreams } from "../src/types.ts";

const model: Model<Api> = {
	id: "test",
	name: "Test",
	provider: "test",
	api: "test",
	baseUrl: "https://test.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = { messages: [] };
function gate<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
it.each(["stream", "streamSimple"] as const)(
	"classifies pre-aborted %s setup without calling the provider",
	async (method) => {
		const run = vi.fn(() => {
			throw new Error("must not dispatch");
		});
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				models: [model],
				auth: { apiKey: { name: "key", resolve: async () => ({ auth: {} }) } },
				api: { stream: run, streamSimple: run },
			}),
		);
		const stream = models[method](model, context, { signal: AbortSignal.abort() });
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(await stream.result()).toMatchObject({ stopReason: "aborted" });
		expect(run).not.toHaveBeenCalled();
	},
);
it.each(["stream", "streamSimple"] as const)(
	"classifies %s cancellation while reading or refreshing credentials",
	async (method) => {
		for (const phase of ["read", "refresh"] as const) {
			const started = gate<void>();
			const paused = gate<void>();
			const controller = new AbortController();
			const credentials = new InMemoryCredentialStore();
			const old = { type: "oauth", access: "old", refresh: "refresh", expires: 0 } as const;
			await credentials.modify("test", async () => old);
			if (phase === "read")
				vi.spyOn(credentials, "read").mockImplementation(async () => {
					started.resolve();
					await paused.promise;
					return old;
				});
			const run = vi.fn(() => {
				throw new Error("must not dispatch");
			});
			const models = createModels({ credentials });
			models.setProvider(
				createProvider({
					id: "test",
					models: [model],
					api: { stream: run, streamSimple: run },
					auth: {
						oauth: {
							name: "test",
							login: async () => old,
							toAuth: async (credential) => ({ apiKey: credential.access }),
							refresh: async () => {
								started.resolve();
								await paused.promise;
								return { ...old, access: "new", expires: Date.now() + 3600000 };
							},
						},
					},
				}),
			);
			const stream = models[method](model, context, { signal: controller.signal });
			await started.promise;
			controller.abort();
			expect((await stream.result()).stopReason).toBe("aborted");
			paused.resolve();
			await paused.promise;
			expect(run).not.toHaveBeenCalled();
		}
	},
);
it.each(["stream", "streamSimple", "fetchDeferred"] as const)(
	"classifies lazy %s module loading aborts and avoids late dispatch",
	async (method) => {
		for (const outcome of ["resolve", "reject"] as const) {
			const started = gate<void>();
			const pending = gate<ProviderStreams>();
			const run = vi.fn(() => {
				throw new Error("must not dispatch");
			});
			const controller = new AbortController();
			const api = lazyApi(
				() => {
					started.resolve();
					return pending.promise;
				},
				{ fetchDeferred: true },
			);
			const stream =
				method === "fetchDeferred"
					? api.fetchDeferred!(
							model,
							{ provider: "test", modelId: "test", api: "test", id: "id" },
							{ signal: controller.signal },
						)
					: api[method](model, context, { signal: controller.signal });
			await started.promise;
			controller.abort();
			if (outcome === "resolve") pending.resolve({ stream: run, streamSimple: run, fetchDeferred: run });
			else pending.reject(new Error("import failed"));
			expect((await stream.result()).stopReason).toBe("aborted");
			expect(run).not.toHaveBeenCalled();
		}
	},
);
