import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../../src/harness/compaction/branch-summarization.ts";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
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
