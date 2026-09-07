import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../src/core/compaction/compaction.ts";
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
