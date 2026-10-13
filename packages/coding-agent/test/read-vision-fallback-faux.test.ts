import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

const TEXT_MODEL = { provider: "test", id: "text-only", input: ["text"] } as unknown as Model<Api>;

function createContext(model: Model<Api>): ExtensionContext {
	return {
		model: TEXT_MODEL,
		modelRegistry: {
			getAvailable: () => [model],
			find: (provider: string, id: string) => (model.provider === provider && model.id === id ? model : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "unused" }),
		},
	} as unknown as ExtensionContext;
}

function createTool(visionFallbackModel: string) {
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

describe("vision fallback through a real provider implementation", () => {
	it("returns the model's description and surfaces provider errors", async () => {
		// Exercises the real completeSimple -> streamSimple -> api-registry path, no mocking.
		const faux = registerFauxProvider({ models: [{ id: "faux-vision", input: ["text", "image"] }] });
		try {
			const model = faux.getModel() as Model<Api>;
			const tool = createTool(`${model.provider}/${model.id}`);
			const context = createContext(model);

			faux.setResponses([fauxAssistantMessage("A terminal with a failing test in red.")]);
			const described = await tool.execute("faux-1", { path: "screenshot.png" }, undefined, undefined, context);
			expect(resultText(described)).toContain("A terminal with a failing test in red.");
			expect(resultText(described)).toContain(`[Image described by ${model.provider}/${model.id}]`);

			// pi-ai reports provider failures in the resolved message; the description must name them.
			faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })]);
			const failed = await tool.execute("faux-2", { path: "screenshot.png" }, undefined, undefined, context);
			expect(resultText(failed)).toContain("[Vision fallback failed: 401 invalid api key]");
			expect(failed.content.some((part) => part.type === "image")).toBe(true);
		} finally {
			faux.unregister();
		}
	});
});
