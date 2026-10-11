import { describe, expect, it } from "vitest";
import { createModels } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";

describe("faux streaming cancellation", () => {
	it("interrupts a throttled chunk delay", async () => {
		const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 16, max: 16 } });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("1234567890123456")]);
		const controller = new AbortController();
		const startedAt = Date.now();

		const completion = models.completeSimple(faux.getModel(), { messages: [] }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		const result = await completion;

		expect(result.stopReason).toBe("aborted");
		expect(Date.now() - startedAt).toBeLessThan(500);
	});
});
