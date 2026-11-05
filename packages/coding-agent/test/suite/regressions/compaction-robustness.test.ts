import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function usage(input: number) {
	return {
		input,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seed(h: Harness, messages: Message[]): void {
	for (const message of messages) h.sessionManager.appendMessage(message);
	h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages as AgentMessage[];
}

function compactionEntries(h: Harness) {
	return h.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
}

const smallSettings = { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 };

describe("automatic compaction robustness", () => {
	it("succeeds when reasoning needs more output than a reserve-derived summary cap", async () => {
		// Reported failure: a 1M-window adaptive-thinking model at a high thinking level spent the
		// old 13,107-token summary cap on reasoning, so every compaction stopped at the cap.
		harness = await createHarness({
			models: [{ id: "big", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true }],
			settings: { retry: { enabled: false } },
		});
		harness.session.setThinkingLevel("high");
		const model = harness.getModel();
		seed(harness, [
			{ role: "user", content: "old ".repeat(60_000), timestamp: 1 },
			{ ...fauxAssistantMessage("old answer", { timestamp: 2 }), provider: model.provider, model: model.id },
			{ role: "user", content: "recent ".repeat(20_000), timestamp: 3 },
			{
				...fauxAssistantMessage("recent answer", { timestamp: 4 }),
				provider: model.provider,
				model: model.id,
				usage: usage(880_000),
			},
		]);
		const summaryLimits: Array<number | undefined> = [];
		harness.setResponses([
			(_context, options, _state, requestModel) => {
				summaryLimits.push(options?.maxTokens);
				const limit = options?.maxTokens ?? requestModel.maxTokens;
				// Reasoning spends 25k output tokens before the summary text starts.
				return limit < 30_000
					? fauxAssistantMessage("partial", { stopReason: "length" })
					: fauxAssistantMessage("## Goal\ncheckpoint");
			},
			fauxAssistantMessage("answer"),
		]);

		await harness.session.prompt("next");

		expect(summaryLimits).toEqual([128_000]);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.summary).toContain("checkpoint");
		expect(harness.eventsOfType("context_limit")).toEqual([]);
		expect(compactionEntries(harness)).toHaveLength(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("answer");
	});

	it("compacts before sending a prompt that crosses the threshold", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 4_000 }],
			settings: { compaction: smallSettings, retry: { enabled: false } },
		});
		const model = harness.getModel();
		seed(harness, [
			{ role: "user", content: "old ".repeat(12_000), timestamp: 1 },
			{ ...fauxAssistantMessage("old answer", { timestamp: 2 }), provider: model.provider, model: model.id },
			{ role: "user", content: "recent", timestamp: 3 },
			{
				...fauxAssistantMessage("recent answer", { timestamp: 4 }),
				provider: model.provider,
				model: model.id,
				usage: usage(12_500),
			},
		]);
		const sentPrompts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("## Goal\ncheckpoint"),
			(context) => {
				sentPrompts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("answer");
			},
		]);

		await harness.session.prompt("p ".repeat(9_000));

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("context_limit")).toEqual([]);
		expect(sentPrompts).toHaveLength(1);
		expect(sentPrompts[0]).toContain("checkpoint");
		expect(sentPrompts[0]).not.toContain("old old old");
		expect(getUserTexts(harness).at(-1)).toContain("p p p");
	});

	it("compacts after a completed run instead of stopping at the limit without an attempt", async () => {
		// An extension sends only the newest message, so provider usage stays far below the
		// session size. The trigger and the limit check must agree on the context estimate.
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 4_000 }],
			settings: { compaction: smallSettings, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({ messages: event.messages.slice(-1) }));
				},
			],
		});
		const model = harness.getModel();
		seed(harness, [
			{ role: "user", content: "old ".repeat(7_000), timestamp: 1 },
			{ ...fauxAssistantMessage("old answer", { timestamp: 2 }), provider: model.provider, model: model.id },
			{ role: "user", content: "mid ".repeat(7_000), timestamp: 3 },
			{
				...fauxAssistantMessage("mid answer", { timestamp: 4 }),
				provider: model.provider,
				model: model.id,
				usage: usage(2_000),
			},
		]);
		harness.setResponses([
			fauxAssistantMessage("long answer ".repeat(1_200)),
			...Array.from({ length: 6 }, () => fauxAssistantMessage("## Goal\ncheckpoint")),
		]);

		await harness.session.prompt("go");

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result).toBeDefined();
		expect(harness.eventsOfType("context_limit")).toEqual([]);
		expect(compactionEntries(harness)).toHaveLength(1);
	});

	it("recovers from Anthropic's input-plus-max_tokens limit error with one compact-and-retry", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 4_000 }],
			settings: { compaction: smallSettings, retry: { enabled: false } },
		});
		const model = harness.getModel();
		seed(harness, [
			{ role: "user", content: "old ".repeat(9_000), timestamp: 1 },
			{ ...fauxAssistantMessage("old answer", { timestamp: 2 }), provider: model.provider, model: model.id },
		]);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 16500 + 4000 > 20000, decrease input length or `max_tokens` and try again"}}',
			}),
			fauxAssistantMessage("## Goal\ncheckpoint"),
			fauxAssistantMessage("answer after recovery"),
		]);

		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "overflow", willRetry: true });
		expect(harness.eventsOfType("compaction_end").at(-1)?.result).toBeDefined();
		expect(getMessageText(harness.session.messages.at(-1))).toBe("answer after recovery");
	});

	it("rejects an extension compaction whose kept entry is not on the branch", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 4_000 }],
			settings: { compaction: smallSettings, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "extension checkpoint",
							firstKeptEntryId: "not-an-entry",
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		const model = harness.getModel();
		seed(harness, [
			{ role: "user", content: "old ".repeat(6_000), timestamp: 1 },
			{ ...fauxAssistantMessage("old answer", { timestamp: 2 }), provider: model.provider, model: model.id },
			{ role: "user", content: "recent ".repeat(2_000), timestamp: 3 },
			{ ...fauxAssistantMessage("recent answer", { timestamp: 4 }), provider: model.provider, model: model.id },
		]);
		const before = harness.sessionManager.buildSessionContext().messages;

		await expect(harness.session.compact()).rejects.toThrow("which is not on the compacted branch");

		expect(compactionEntries(harness)).toHaveLength(0);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual(before);
	});
});

describe("manual compaction robustness", () => {
	it("summarizes a history larger than one summary request", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20_000, maxTokens: 4_000 }],
			settings: { compaction: smallSettings, retry: { enabled: false } },
		});
		const model = harness.getModel();
		const messages: Message[] = [];
		for (let i = 0; i < 12; i++) {
			messages.push({ role: "user", content: `request ${i} `.repeat(1_200), timestamp: i * 2 + 1 });
			messages.push({
				...fauxAssistantMessage(`answer ${i}`, { timestamp: i * 2 + 2 }),
				provider: model.provider,
				model: model.id,
			});
		}
		seed(harness, messages);
		let summaries = 0;
		harness.setResponses(
			Array.from({ length: 20 }, () => () => fauxAssistantMessage(`## Goal\nsummary ${++summaries}`)),
		);

		const result = await harness.session.compact();

		expect(summaries).toBeGreaterThan(1);
		expect(result.summary).toContain(`summary ${summaries}`);
		expect(compactionEntries(harness)).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});
});
