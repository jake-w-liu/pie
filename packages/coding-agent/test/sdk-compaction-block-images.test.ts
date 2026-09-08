import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { generateSummaryWithUsage } from "../src/core/compaction/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

it("applies dynamic image policy to SDK compaction requests without altering stored images", async () => {
	const model: Model<"openai-responses"> = {
		id: "test-model",
		name: "Test model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		maxTokens: 4096,
	};
	const summary: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "A summary" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const messages: Message[] = [
		{
			role: "user",
			timestamp: 1,
			content: [
				{ type: "text", text: "Read the images" },
				{ type: "image", data: "original-image-data", mimeType: "image/png" },
				{ type: "image", data: "second-image-data", mimeType: "image/png" },
			],
		},
		{ ...summary, stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
		{
			role: "toolResult",
			timestamp: 3,
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
			content: [{ type: "image", data: "tool-image-data", mimeType: "image/png" }],
		},
	];
	const original = structuredClone(messages);
	const sessionManager = SessionManager.inMemory();
	for (const message of messages) sessionManager.appendMessage(message);
	const settingsManager = SettingsManager.inMemory({ images: { blockImages: true } });
	const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
	const captured: Context[] = [];
	const streamSpy = vi.spyOn(modelRuntime, "streamSimple").mockImplementation((_model, context) => {
		captured.push(context);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: summary });
		stream.end(summary);
		return stream;
	});
	const { session } = await createAgentSession({
		model,
		modelRuntime,
		sessionManager,
		settingsManager,
		noTools: "all",
		resourceLoader: createTestResourceLoader(),
	});
	try {
		for (const blocked of [true, false, true]) {
			settingsManager.setBlockImages(blocked);
			const result = await generateSummaryWithUsage(
				messages,
				model,
				1024,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				session.agent.streamFunction,
				undefined,
				undefined,
				undefined,
				session.sessionId,
				"Live system prompt",
			);
			expect(result.text).toBe("A summary");
			const context = captured.at(-1);
			expect(context?.systemPrompt).toBe("Live system prompt");
			const outgoing = JSON.stringify(context?.messages);
			if (blocked) {
				expect(outgoing).not.toContain("image-data");
				expect(context?.messages[0].content).toEqual([
					{ type: "text", text: "Read the images" },
					{ type: "text", text: "Image reading is disabled." },
				]);
			} else {
				expect(outgoing).toContain("original-image-data");
				expect(outgoing).toContain("tool-image-data");
			}
			expect(messages).toEqual(original);
			expect(sessionManager.buildSessionContext().messages).toEqual(original);
		}
		expect(streamSpy).toHaveBeenCalledTimes(3);
	} finally {
		session.dispose();
		streamSpy.mockRestore();
	}
});
