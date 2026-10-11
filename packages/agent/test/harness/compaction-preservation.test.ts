import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../../src/harness/compaction/branch-summarization.ts";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	generateSummary,
	prepareCompaction,
} from "../../src/harness/compaction/compaction.ts";
import { formatFileOperations, serializeConversation } from "../../src/harness/compaction/utils.ts";
import type { Entry } from "../../src/harness/session/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";

describe("checkpoint preservation", () => {
	it("rejects usage from before the latest checkpoint", () => {
		const old = fauxAssistantMessage("old answer", { timestamp: 1 });
		old.usage = { ...old.usage, input: 9000, totalTokens: 9000 };
		const estimate = estimateContextTokens([
			{ role: "compactionSummary", summary: "new summary", tokensBefore: 9000, timestamp: 2 },
			old,
		]);
		expect(estimate.lastUsageIndex).toBeNull();
		expect(estimate.tokens).toBeLessThan(9000);
	});

	it("preserves branch metadata and respects a branch input budget", () => {
		const entries: Entry[] = [
			{
				type: "branch_summary",
				id: "summary",
				parentId: null,
				seq: 1,
				timestamp: 1,
				fromId: "old",
				summary: "x".repeat(40000),
				details: { readFiles: ["read.ts"], modifiedFiles: ["edit.ts"] },
			},
			{
				type: "message",
				id: "kept",
				parentId: "summary",
				seq: 2,
				timestamp: 2,
				message: { role: "user", content: "retained", timestamp: 2 },
			},
		];
		const prepared = getOrThrow(prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }));
		expect(prepared?.fileOps.read).toEqual(new Set(["read.ts"]));
		expect(prepared?.fileOps.edited).toEqual(new Set(["edit.ts"]));
		expect(prepareBranchEntries(entries, 100).totalTokens).toBeLessThanOrEqual(100);
	});

	it("bounds visible metadata and preserves result attribution", () => {
		const files = Array.from({ length: 5000 }, (_, i) => `${i}/${"path/".repeat(20)}file.ts`);
		const text = formatFileOperations(files, [], 1000);
		expect(text.length).toBeLessThanOrEqual(1000);
		expect(text).toContain("summary metadata");
		expect(
			serializeConversation([
				{
					role: "toolResult",
					toolName: "read",
					toolCallId: "call-7",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 1,
				},
			]),
		).toContain("read (call call-7)");
	});

	it("classifies compaction cuts by the first visible entry after metadata", () => {
		const usage = fauxAssistantMessage("answer").usage;
		const base: Entry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				seq: 1,
				timestamp: 1,
				message: { role: "user", content: "first ".repeat(200), timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				seq: 2,
				timestamp: 2,
				message: { ...fauxAssistantMessage("answer ".repeat(200)), usage },
			},
		];
		const tail: Entry[] = [
			{
				type: "message",
				id: "u2",
				parentId: "a1",
				seq: 4,
				timestamp: 4,
				message: { role: "user", content: "second ".repeat(400), timestamp: 4 },
			},
			{
				type: "message",
				id: "a2",
				parentId: "u2",
				seq: 5,
				timestamp: 5,
				message: fauxAssistantMessage("answer ".repeat(400)),
			},
		];
		const metadata = {
			type: "model_change" as const,
			id: "model",
			parentId: "a1",
			seq: 3,
			timestamp: 3,
			provider: "openai",
			modelId: "gpt",
		};
		const without = getOrThrow(
			prepareCompaction([...base, ...tail], { enabled: true, reserveTokens: 1000, keepRecentTokens: 2500 }),
		);
		const withMetadata = getOrThrow(
			prepareCompaction([...base, metadata, ...tail], {
				enabled: true,
				reserveTokens: 1000,
				keepRecentTokens: 2500,
			}),
		);
		expect(withMetadata).toMatchObject({
			isSplitTurn: without?.isSplitTurn,
			messagesToSummarize: without?.messagesToSummarize,
			turnPrefixMessages: without?.turnPrefixMessages,
		});
	});

	it("returns compaction completion failures as Results", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const controller = new AbortController();
		controller.abort();

		const result = await generateSummary(
			[{ role: "user", content: "summarize", timestamp: 1 }],
			models,
			faux.getModel(),
			1000,
			controller.signal,
		);

		expect(result).toMatchObject({ ok: false, error: { name: "CompactionError", code: "aborted" } });

		const overBudget = await generateSummary(
			[{ role: "user", content: "large ".repeat(1000), timestamp: 1 }],
			models,
			{ ...faux.getModel(), contextWindow: 100, maxTokens: 20 },
			20,
		);
		expect(overBudget).toMatchObject({
			ok: false,
			error: { name: "CompactionError", code: "summarization_failed" },
		});

		faux.setResponses([
			() => {
				throw new Error("provider exploded");
			},
		]);
		const providerFailure = await generateSummary(
			[{ role: "user", content: "summarize", timestamp: 1 }],
			models,
			faux.getModel(),
			1000,
		);
		expect(providerFailure).toMatchObject({
			ok: false,
			error: { name: "CompactionError", code: "summarization_failed" },
		});
	});

	it("rejects an impossible branch input budget before a provider call", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const result = await generateBranchSummary([], {
			models,
			model: { ...faux.getModel(), contextWindow: 8192 },
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(false);
		expect(faux.state.callCount).toBe(0);
	});

	it("fits branch output into a small legal reserve", async () => {
		const faux = fauxProvider({ provider: "small-reserve", models: [{ id: "model", contextWindow: 10_000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("summary")]);
		const entries: Entry[] = [
			{
				type: "message",
				id: "message",
				parentId: null,
				seq: 1,
				timestamp: 1,
				message: { role: "user", content: "content ".repeat(1000), timestamp: 1 },
			},
		];

		const result = await generateBranchSummary(entries, {
			models,
			model: faux.getModel(),
			reserveTokens: 100,
			signal: new AbortController().signal,
		});

		expect(result.ok).toBe(true);
		expect(faux.state.callCount).toBe(1);
	});

	it.each([false, true])("preserves previous history with empty new history (split: %s)", async (isSplitTurn) => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("new turn prefix")]);
		const preparation: CompactionPreparation = {
			messagesToSummarize: [],
			turnPrefixMessages: isSplitTurn ? [{ role: "user", content: "ongoing task", timestamp: 1 }] : [],
			retainedTail: [{ role: "user", content: "retained context", timestamp: 2 }],
			isSplitTurn,
			tokensBefore: 20000,
			previousSummary: "Never delete the production database.",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const result = getOrThrow(await compact(preparation, models, faux.getModel()));
		expect(result.summary).toContain(preparation.previousSummary);
		expect(result.retainedTail).toEqual(preparation.retainedTail);
		expect(faux.state.callCount).toBe(isSplitTurn ? 1 : 0);
		if (isSplitTurn) expect(result.summary).toContain("new turn prefix");
		else expect(result.usage?.totalTokens).toBe(0);
	});
});
