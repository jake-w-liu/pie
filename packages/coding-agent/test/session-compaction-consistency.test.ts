import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("compaction session consistency", () => {
	it("carries structured branch-summary file tracking into compaction", () => {
		const manager = SessionManager.inMemory();
		manager.branchWithSummary(null, "branch summary without filenames", {
			readFiles: ["read-only.ts"],
			modifiedFiles: ["branch-only.ts"],
		});
		manager.appendMessage({ role: "user", content: "retained request".repeat(1000), timestamp: 2 });
		const preparation = prepareCompaction(manager.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		expect(preparation?.fileOps.read).toEqual(new Set(["read-only.ts"]));
		expect(preparation?.fileOps.edited).toEqual(new Set(["branch-only.ts"]));
	});

	it("does not restore superseded checkpoints inside the retained span", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("first answer"));
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("kept answer"));
		manager.appendCompaction("superseded checkpoint", first, 10000);
		manager.appendMessage({ role: "user", content: "latest", timestamp: 3 });
		const latest = manager.appendCompaction("consolidated checkpoint", kept, 12000);
		expect(
			manager
				.buildContextEntries()
				.filter((entry) => entry.type === "compaction")
				.map((entry) => entry.id),
		).toEqual([latest]);
		expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
	});

	it.each(["compaction", "branch"])("does not advance the branch when %s persistence fails", (operation) => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("answer"));
		const previousLeaf = manager.getLeafId();
		const previousEntries = manager.getEntries();
		const previousContext = manager.buildSessionContext();
		const error = new Error("injected write failure");
		const persist = vi.spyOn(manager, "_persist").mockImplementationOnce(() => {
			throw error;
		});
		try {
			expect(() =>
				operation === "compaction"
					? manager.appendCompaction("failed checkpoint", first, 1000)
					: manager.branchWithSummary(first, "failed branch checkpoint"),
			).toThrow(error);
			expect(manager.getLeafId()).toBe(previousLeaf);
			expect(manager.getEntries()).toEqual(previousEntries);
			expect(manager.buildSessionContext()).toEqual(previousContext);
		} finally {
			persist.mockRestore();
		}
		const next = manager.appendMessage({ role: "user", content: "retry", timestamp: 4 });
		expect(manager.getEntry(next)?.parentId).toBe(previousLeaf);
	});
});
