import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("small context windows with default compaction settings", () => {
	it.each([8_192, 16_384])("accepts a short prompt on a %i-token model", async (contextWindow) => {
		harness = await createHarness({ models: [{ id: `small-${contextWindow}`, contextWindow, maxTokens: 2_048 }] });
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("context_limit")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("compacts a model whose output limit equals its context window", async () => {
		harness = await createHarness({ models: [{ id: "small-8k", contextWindow: 8_192, maxTokens: 8_192 }] });
		const { session, sessionManager } = harness;
		const model = harness.getModel();
		for (let i = 0; i < 3; i++) {
			sessionManager.appendMessage({ role: "user", content: `question ${i} `.repeat(40), timestamp: i * 2 });
			sessionManager.appendMessage({
				...fauxAssistantMessage(`answer ${i} `.repeat(40)),
				provider: model.provider,
				model: model.id,
			});
		}
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		// No recent tokens fit below the trigger, so the last turn is split: history plus turn-prefix summaries.
		harness.setResponses([fauxAssistantMessage("## Goal\nsummary"), fauxAssistantMessage("turn prefix")]);

		const result = await session.compact();

		expect(result.summary).toContain("summary");
		expect(session.messages[0]?.role).toBe("compactionSummary");
	});
});
