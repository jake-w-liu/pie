import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

const state = vi.hoisted(() => ({
	calls: [] as Array<{ provider: string; id: string; hasImagePart: boolean; apiKey: string | undefined }>,
	response: "A terminal showing a failing test." as string | undefined,
	stopReason: "stop" as string,
	errorMessage: undefined as string | undefined,
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: async (
			model: Model<Api>,
			context: { messages: Array<{ content: Array<{ type: string }> | string }> },
			options: { apiKey?: string },
		): Promise<AssistantMessage> => {
			const content = context.messages[0]?.content;
			state.calls.push({
				provider: model.provider,
				id: model.id,
				hasImagePart: Array.isArray(content) && content.some((part) => part.type === "image"),
				apiKey: options?.apiKey,
			});
			return {
				role: "assistant",
				content: state.response === undefined ? [] : [{ type: "text", text: state.response }],
				stopReason: state.stopReason,
				errorMessage: state.errorMessage,
				api: "test",
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			} as unknown as AssistantMessage;
		},
	};
});

const TEXT_MODEL = { provider: "test", id: "text-only", input: ["text"] } as unknown as Model<Api>;
const VISION_MODEL = { provider: "test", id: "vision-1", input: ["image"] } as unknown as Model<Api>;

function createContext(options: { model: Model<Api>; available?: Model<Api>[]; authOk?: boolean }): ExtensionContext {
	const available = options.available ?? [VISION_MODEL];
	return {
		model: options.model,
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
			getApiKeyAndHeaders: async () =>
				options.authOk === false ? { ok: false, error: "missing" } : { ok: true, apiKey: "test-key" },
		},
	} as unknown as ExtensionContext;
}

function createTool(visionFallbackModel?: string) {
	return createReadToolDefinition("/tmp", {
		visionFallbackModel,
		operations: {
			access: async () => {},
			readFile: async () => TINY_PNG,
			detectImageMimeType: async () => "image/png",
		},
	});
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

describe("vision fallback", () => {
	it("describes the image with the configured model when the active model has no image input", async () => {
		state.calls.length = 0;
		state.response = "A terminal showing a failing test.";
		const tool = createTool("test/vision-1");
		const result = await tool.execute(
			"vision-1",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL }),
		);

		expect(state.calls).toHaveLength(1);
		expect(state.calls[0]).toMatchObject({
			provider: "test",
			id: "vision-1",
			hasImagePart: true,
			apiKey: "test-key",
		});
		expect(resultText(result)).toContain("A terminal showing a failing test.");
		expect(resultText(result)).toContain("[Image described by test/vision-1]");
	});

	it("accepts a bare model id", async () => {
		state.calls.length = 0;
		const tool = createTool("vision-1");
		await tool.execute(
			"vision-2",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL }),
		);
		expect(state.calls).toHaveLength(1);
	});

	it("does not call a vision model when the active model accepts images", async () => {
		state.calls.length = 0;
		const tool = createTool("test/vision-1");
		const result = await tool.execute(
			"vision-3",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: VISION_MODEL }),
		);
		expect(state.calls).toHaveLength(0);
		expect(resultText(result)).not.toContain("described by");
	});

	it("reports an unavailable fallback model without failing the read", async () => {
		state.calls.length = 0;
		const tool = createTool("test/missing");
		const result = await tool.execute(
			"vision-4",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL, available: [TEXT_MODEL] }),
		);
		expect(resultText(result)).toContain('[Vision fallback failed: model "test/missing" is not available]');
		expect(result.content.some((part) => part.type === "image")).toBe(true);
	});

	it("reports missing credentials without failing the read", async () => {
		state.calls.length = 0;
		const tool = createTool("test/vision-1");
		const result = await tool.execute(
			"vision-5",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL, authOk: false }),
		);
		expect(resultText(result)).toContain("[Vision fallback failed: no credentials for test/vision-1]");
	});

	it("reports an empty model response without failing the read", async () => {
		state.calls.length = 0;
		state.response = undefined;
		const tool = createTool("test/vision-1");
		const result = await tool.execute(
			"vision-6",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL }),
		);
		expect(resultText(result)).toContain("returned no text");
		state.response = "restored";
	});

	it("reports provider errors from the resolved message", async () => {
		// pi-ai encodes provider failures as stopReason "error" plus errorMessage, not as a throw.
		state.calls.length = 0;
		state.stopReason = "error";
		state.errorMessage = "401 invalid api key";
		state.response = undefined;
		const tool = createTool("test/vision-1");
		const result = await tool.execute(
			"vision-error",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL }),
		);
		expect(resultText(result)).toContain("[Vision fallback failed: 401 invalid api key]");
		state.stopReason = "stop";
		state.errorMessage = undefined;
		state.response = "restored";
	});

	it("keeps the plain note when no fallback is configured", async () => {
		state.calls.length = 0;
		const tool = createTool();
		const result = await tool.execute(
			"vision-7",
			{ path: "screenshot.png" },
			undefined,
			undefined,
			createContext({ model: TEXT_MODEL }),
		);
		expect(state.calls).toHaveLength(0);
		expect(resultText(result)).toContain("does not support images");
	});
});
