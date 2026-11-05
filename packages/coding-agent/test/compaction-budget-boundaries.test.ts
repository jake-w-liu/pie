import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	prepareCompaction,
} from "../src/core/compaction/compaction.ts";
import { formatFileOperations, serializeConversation } from "../src/core/compaction/utils.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("compaction budget boundaries", () => {
	it("makes progress with default retention on a 32k context window", () => {
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 17; i++) {
			manager.appendMessage({ role: "user", content: "x".repeat(4000), timestamp: i * 2 });
			manager.appendMessage(fauxAssistantMessage("ok", { timestamp: i * 2 + 1 }));
		}
		const prepared = prepareCompaction(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, 32768);
		expect(prepared).toBeDefined();
		expect((prepared?.messagesToSummarize.length ?? 0) + (prepared?.turnPrefixMessages.length ?? 0)).toBeGreaterThan(
			0,
		);
	});

	it("does not admit an oversized checkpoint past a branch's input budget", () => {
		const manager = SessionManager.inMemory();
		manager.branchWithSummary(null, "x".repeat(40000));
		const prepared = prepareBranchEntries(manager.getBranch(), 100);
		expect(prepared.totalTokens).toBeLessThanOrEqual(100);
	});

	it("bounds visible file tags without truncating file names or changing full tracking", () => {
		const files = Array.from({ length: 5000 }, (_, i) => `${i}/${"long-path/".repeat(10)}file.ts`);
		const tags = formatFileOperations([], files, 1000);
		expect(tags.length).toBeLessThanOrEqual(1000);
		expect(tags).toContain("<modified-files>");
		expect(tags).toContain("</modified-files>");
		expect(tags).toContain("summary metadata");
		expect(files).toHaveLength(5000);
		for (const line of tags.split("\n").filter((line) => line.endsWith("file.ts"))) {
			expect(files).toContain(line);
		}
		expect(formatFileOperations(files, [], 0)).toBe("");
	});

	it("preserves the identity of a tool result when its call was outside the branch budget", () => {
		const text = serializeConversation([
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "call-17",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 1,
			},
		]);
		expect(text).toContain("read");
		expect(text).toContain("call-17");
	});
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

describe("compaction preparation", () => {
	it("calibrates retention from provider usage when message estimates undercount", () => {
		const build = (reportedPrompt: number | undefined) => {
			const manager = SessionManager.inMemory();
			for (let i = 0; i < 10; i++) {
				manager.appendMessage({ role: "user", content: `request ${i} `.repeat(400), timestamp: i * 2 });
				manager.appendMessage(fauxAssistantMessage(`answer ${i}`, { timestamp: i * 2 + 1 }));
			}
			if (reportedPrompt !== undefined) {
				// Encrypted reasoning or dense content is invisible to the chars/4 estimate.
				manager.appendMessage({
					...fauxAssistantMessage("latest", { timestamp: 100 }),
					usage: usage(reportedPrompt),
				});
			}
			return prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 1000, keepRecentTokens: 6000 });
		};
		const uncalibrated = build(undefined);
		const calibrated = build(150_000);
		expect(uncalibrated && calibrated).toBeTruthy();
		// Each turn is ~1k estimated tokens. Uncalibrated retention keeps about six turns;
		// with usage reporting ~5x the estimate, only about one turn fits the same budget.
		expect(calibrated!.messagesToSummarize.length).toBeGreaterThan(uncalibrated!.messagesToSummarize.length + 6);
	});

	it("moves the cut past one large recent entry that would keep the context near the threshold", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old request ".repeat(200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		const huge = manager.appendMessage({ role: "user", content: "x".repeat(64_000), timestamp: 3 });
		const answer = manager.appendMessage(fauxAssistantMessage("answer to the huge request", { timestamp: 4 }));
		const settings: CompactionSettings = { enabled: true, reserveTokens: 2000, keepRecentTokens: 2000 };

		// Without a context window there is no threshold, so the crossing entry is retained.
		expect(prepareCompaction(manager.getBranch(), settings)?.firstKeptEntryId).toBe(huge);
		// A 20k window triggers at 17.4k; retaining a 16k-token entry would free almost nothing.
		const prepared = prepareCompaction(manager.getBranch(), settings, 20_000);
		expect(prepared?.firstKeptEntryId).toBe(answer);
		expect(prepared?.isSplitTurn).toBe(true);
		expect(prepared?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
	});

	it("caps retention at the latest cut point when even the newest entry exceeds the bound", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		manager.appendMessage({ role: "user", content: "a".repeat(40_000), timestamp: 3 });
		const newest = manager.appendMessage({ role: "user", content: "b".repeat(40_000), timestamp: 4 });
		const result = findCutPoint(manager.getBranch(), 0, manager.getBranch().length, 1000, { maxKeepTokens: 5000 });
		expect(manager.getBranch()[result.firstKeptEntryIndex]?.id).toBe(newest);
	});

	it("lets a follow-up compaction make progress right after a compaction", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		const kept = manager.appendMessage({ role: "user", content: "y".repeat(64_000), timestamp: 3 });
		const answer = manager.appendMessage(fauxAssistantMessage("answer", { timestamp: 4 }));
		manager.appendCompaction("first checkpoint", kept, 30_000);
		const settings: CompactionSettings = { enabled: true, reserveTokens: 2000, keepRecentTokens: 2000 };

		const prepared = prepareCompaction(manager.getBranch(), settings, 20_000);
		expect(prepared?.previousSummary).toBe("first checkpoint");
		expect(prepared?.firstKeptEntryId).toBe(answer);
		expect(prepared?.turnPrefixMessages).toHaveLength(1);
	});

	it("reports nothing to compact right after a compaction when no more history can be removed", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		const kept = manager.appendMessage({ role: "user", content: "short kept request", timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("answer", { timestamp: 4 }));
		manager.appendCompaction("checkpoint", kept, 30_000);
		expect(prepareCompaction(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, 128_000)).toBeUndefined();
	});

	it("replaces invalid token settings with defaults", () => {
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 30; i++) {
			manager.appendMessage({ role: "user", content: `request ${i} `.repeat(1000), timestamp: i * 2 });
			manager.appendMessage(fauxAssistantMessage(`answer ${i}`, { timestamp: i * 2 + 1 }));
		}
		const invalid = {
			enabled: true,
			reserveTokens: Number.NaN,
			keepRecentTokens: "many" as unknown as number,
		};
		const fromInvalid = prepareCompaction(manager.getBranch(), invalid, 200_000);
		const fromDefaults = prepareCompaction(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, 200_000);
		expect(fromInvalid?.firstKeptEntryId).toBe(fromDefaults?.firstKeptEntryId);
		expect(fromInvalid?.messagesToSummarize.length).toBeGreaterThan(0);
	});
});
