import { describe, expect, it, vi } from "vitest";
import { createImagesModels, createImagesProvider, type ImagesProvider } from "../src/images-models.ts";
import type { AssistantImages, ImagesApi, ImagesModel } from "../src/types.ts";

const model: ImagesModel<"openrouter-images"> = {
	id: "offline",
	name: "offline",
	api: "openrouter-images",
	provider: "offline",
	baseUrl: "https://example.invalid",
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const success: AssistantImages = {
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "stop",
	output: [],
	timestamp: 0,
};
const authContext = { env: async () => undefined, fileExists: async () => false };
const auth = { apiKey: { name: "Offline", resolve: async () => undefined } };

function refreshProvider(refreshModels: () => Promise<readonly ImagesModel<ImagesApi>[]>): ImagesProvider {
	return createImagesProvider({
		id: "offline",
		auth,
		models: [model],
		refreshModels,
		api: { generateImages: async () => success },
	});
}

describe("offline image runtime failure contracts", () => {
	it.each([false, true])(
		"returns an error result for sync and async provider failure (configured auth: %s)",
		async (configured) => {
			const images = createImagesModels({ authContext });
			const failure = new Error("offline generation failed");
			for (const asynchronous of [false, true]) {
				const generateImages = vi.fn(() => {
					if (asynchronous) return Promise.reject(failure);
					throw failure;
				});
				images.setProvider(
					createImagesProvider({
						id: "offline",
						models: [model],
						api: { generateImages },
						auth: {
							apiKey: {
								name: "Offline",
								resolve: async () => (configured ? { auth: { apiKey: "offline-fixture" } } : undefined),
							},
						},
					}),
				);
				expect(await images.generateImages(model, { input: [] })).toMatchObject({
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: "error",
					errorMessage: failure.message,
				});
				expect(generateImages).toHaveBeenCalledOnce();
			}
		},
	);

	it("retains successful result identity and no-auth options", async () => {
		const images = createImagesModels({ authContext });
		const generateImages = vi.fn(async () => success);
		images.setProvider(createImagesProvider({ id: "offline", auth, models: [model], api: { generateImages } }));
		const context = { input: [] };
		const options = { metadata: { fixture: "unchanged" } };
		expect(await images.generateImages(model, context, options)).toBe(success);
		expect(generateImages).toHaveBeenCalledWith(model, context, options);
	});

	it("preserves the baseline and retries after a synchronous refresh callback failure", async () => {
		const updated = { ...model, id: "updated" };
		const failure = new Error("synchronous setup failure");
		const callback = vi.fn(() => {
			if (callback.mock.calls.length === 1) throw failure;
			return Promise.resolve([updated]);
		});
		const provider = refreshProvider(callback);
		const first = provider.refreshModels!();
		const concurrent = provider.refreshModels!();
		expect(first).toBe(concurrent);
		await expect(first).rejects.toBe(failure);
		expect(provider.getModels()).toEqual([model]);
		await provider.refreshModels!();
		expect(callback).toHaveBeenCalledTimes(2);
		expect(provider.getModels()).toEqual([updated]);
	});

	it("deduplicates concurrent asynchronous refresh and retains the last successful catalog after rejection", async () => {
		let complete: (models: readonly ImagesModel<ImagesApi>[]) => void = () => {
			throw new Error("not initialized");
		};
		const gate = new Promise<readonly ImagesModel<ImagesApi>[]>((resolve) => {
			complete = resolve;
		});
		const failure = new Error("asynchronous refresh failure");
		const callback = vi.fn(() => (callback.mock.calls.length === 1 ? gate : Promise.reject(failure)));
		const provider = refreshProvider(callback);
		const first = provider.refreshModels!();
		expect(provider.refreshModels!()).toBe(first);
		await Promise.resolve();
		expect(callback).toHaveBeenCalledOnce();
		expect(provider.getModels()).toEqual([model]);
		const updated = { ...model, id: "updated" };
		complete([updated]);
		await first;
		expect(provider.getModels()).toEqual([updated]);
		await expect(provider.refreshModels!()).rejects.toBe(failure);
		expect(provider.getModels()).toEqual([updated]);
		await expect(provider.refreshModels!()).rejects.toBe(failure);
		expect(callback).toHaveBeenCalledTimes(3);
	});

	it("keeps specific refresh failures observable while all-provider refresh remains best effort", async () => {
		const images = createImagesModels({ authContext });
		const failure = new Error("offline refresh failed");
		images.setProvider(
			refreshProvider(() => {
				throw failure;
			}),
		);
		await expect(images.refresh("offline")).rejects.toMatchObject({ code: "model_source", cause: failure });
		await expect(images.refresh()).resolves.toBeUndefined();
		expect(images.getModels()).toEqual([model]);
	});
});
