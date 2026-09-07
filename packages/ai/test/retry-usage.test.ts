import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

describe("retry response accounting", () => {
	it.each(["stop", "error", "aborted"] as const)(
		"reports every physical attempt when the last result is %s",
		async (stopReason) => {
			const first = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
			const last = fauxAssistantMessage("final", {
				stopReason,
				errorMessage: stopReason === "error" ? "invalid API key" : undefined,
			});
			first.usage = { ...first.usage, input: 7, totalTokens: 7 };
			last.usage = { ...last.usage, input: 11, totalTokens: 11 };
			const observed: number[] = [];
			let calls = 0;
			const result = await retryAssistantCall(
				async () => (calls++ === 0 ? first : last),
				{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
				undefined,
				{
					onResponse: (response) => {
						observed.push(response.usage.input);
					},
				},
			);
			expect(observed).toEqual([7, 11]);
			expect(result).toBe(last);
		},
	);

	it("reports usage even when retries are disabled", async () => {
		const response = fauxAssistantMessage("done");
		const observed: unknown[] = [];
		await retryAssistantCall(async () => response, undefined, undefined, {
			onResponse: (message) => {
				observed.push(message);
			},
		});
		expect(observed).toEqual([response]);
	});
});
