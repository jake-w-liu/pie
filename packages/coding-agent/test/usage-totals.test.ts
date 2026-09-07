import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { getSummaryUsage, getUsageCostBreakdown, SUMMARIZATION_USAGE_TYPE } from "../src/core/usage-totals.ts";

describe("summary usage records", () => {
	it("persists summary usage even before an ordinary assistant response exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-summary-usage-"));
		try {
			const manager = SessionManager.create(dir, dir);
			const response = fauxAssistantMessage("summary");
			const usage = { ...response.usage, input: 10, totalTokens: 10 };
			manager.appendCustomEntry(SUMMARIZATION_USAGE_TYPE, usage);
			const file = manager.getSessionFile();
			if (!file) throw new Error("Missing session file path");
			expect(existsSync(file)).toBe(true);
			const reopened = SessionManager.open(file);
			expect(getUsageCostBreakdown(reopened.getEntries())).toEqual([
				{ key: "Tools/summaries", cost: 0, tokens: 10 },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts persisted attempts once without discarding older checkpoint usage", () => {
		const manager = SessionManager.inMemory();
		const message = fauxAssistantMessage("summary");
		const usage = {
			...message.usage,
			input: 100,
			totalTokens: 100,
			cost: { ...message.usage.cost, input: 1, total: 1 },
		};
		const first = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendCompaction("old", first, 1000, undefined, false, usage);
		manager.appendCustomEntry(SUMMARIZATION_USAGE_TYPE, usage);
		manager.appendCompaction("new", first, 1000, { usageRecorded: true }, false, usage);
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([{ key: "Tools/summaries", cost: 2, tokens: 200 }]);
	});

	it.each([null, [], {}, { input: 5 }, { cost: null }, "invalid"])(
		"ignores malformed attempt metadata: %j",
		(data) => {
			const manager = SessionManager.inMemory();
			const id = manager.appendCustomEntry(SUMMARIZATION_USAGE_TYPE, data);
			const entry = manager.getEntry(id);
			if (!entry) throw new Error("Missing fixture entry");
			expect(getSummaryUsage(entry)).toBeUndefined();
		},
	);
});
