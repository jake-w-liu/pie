import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	getSummarizationFailure,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const settings = DEFAULT_COMPACTION_SETTINGS;

function msgEntry(id: string, role: string, content: string): SessionEntry {
	const message =
		role === "assistant"
			? { role, content: [{ type: "text", text: content }], timestamp: 1 }
			: { role, content, timestamp: 1 };
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:00Z",
		message,
	} as unknown as SessionEntry;
}

function toolResultEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role: "toolResult", content: [{ type: "text", text: content }], toolCallId: "t", timestamp: 1 },
	} as unknown as SessionEntry;
}

function userMsg(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

describe("shouldCompact", () => {
	it("triggers at the stricter of the ratio and reserve boundaries", () => {
		const window = 100_000;
		// ratioBoundary = 87000, reserveBoundary = 100000-16384 = 83616 -> trigger 83616
		expect(shouldCompact(83_000, window, settings)).toBe(false);
		expect(shouldCompact(84_000, window, settings)).toBe(true);
	});

	it("respects disabled and invalid inputs", () => {
		expect(shouldCompact(90_000, 100_000, { ...settings, enabled: false })).toBe(false);
		expect(shouldCompact(90_000, Number.NaN, settings)).toBe(false);
		expect(shouldCompact(90_000, 0, settings)).toBe(false);
		expect(shouldCompact(0, 100_000, settings)).toBe(false);
	});

	it("uses the ratio boundary when the reserve is not stricter", () => {
		const loose = { ...settings, reserveTokens: 1_000 };
		expect(shouldCompact(86_000, 100_000, loose)).toBe(false);
		expect(shouldCompact(87_000, 100_000, loose)).toBe(true);
	});
});

describe("findCutPoint", () => {
	it("never cuts at a tool result", () => {
		// long user message, tool call, tool result, final user
		const entries: SessionEntry[] = [
			msgEntry("u0", "user", "x".repeat(2000)),
			msgEntry("a0", "assistant", "y".repeat(100)),
			toolResultEntry("tr0", "z".repeat(2000)),
			msgEntry("u1", "user", "next"),
		];
		const result = findCutPoint(entries, 0, entries.length, 500);
		expect(result.firstKeptEntryIndex).toBeGreaterThanOrEqual(0);
		expect(result.firstKeptEntryIndex).not.toBe(2); // tool result index
	});

	it("keeps at least keepRecentTokens of trailing content", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(msgEntry(`u${i}`, "user", "question ".repeat(50)));
			entries.push(msgEntry(`a${i}`, "assistant", "answer ".repeat(50)));
		}
		const result = findCutPoint(entries, 0, entries.length, 2000);
		const keptTokens = entries
			.slice(result.firstKeptEntryIndex)
			.reduce((sum, e) => sum + sessionEntryToMessages(e).reduce((s, m) => s + estimateTokens(m), 0), 0);
		expect(keptTokens).toBeGreaterThanOrEqual(2000);
	});

	it("falls back to the first valid cut point when everything fits", () => {
		const entries: SessionEntry[] = [msgEntry("u0", "user", "a"), msgEntry("a0", "assistant", "b")];
		const result = findCutPoint(entries, 0, entries.length, 100_000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});
});

describe("estimateContextTokens", () => {
	it("uses the last assistant usage plus trailing estimate", () => {
		const lastUsage = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 20,
			totalTokens: 180,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const messages: AgentMessage[] = [
			userMsg("hello"),
			{ ...assistantMsg("hi"), usage: lastUsage } as unknown as AgentMessage,
			userMsg("more trailing text"),
		];
		const est = estimateContextTokens(messages);
		expect(est.usageTokens).toBe(180);
		expect(est.tokens).toBe(180 + Math.ceil("more trailing text".length / 4));
	});

	it("estimates from scratch when there is no assistant usage", () => {
		const messages: AgentMessage[] = [userMsg("a".repeat(80)), userMsg("b".repeat(80))];
		const est = estimateContextTokens(messages);
		expect(est.usageTokens).toBe(0);
		expect(est.tokens).toBe(40);
	});
});

describe("estimateTokens", () => {
	it("overestimates conservatively (chars/4)", () => {
		expect(estimateTokens(userMsg("a".repeat(100)))).toBe(25);
		expect(estimateTokens(assistantMsg("a".repeat(100)))).toBe(25);
	});
});

describe("getSummarizationFailure", () => {
	it("rejects error, length, and empty responses", () => {
		const mk = (stopReason: string, text = "summary") =>
			({ role: "assistant", stopReason, content: [{ type: "text", text }] }) as unknown as Parameters<
				typeof getSummarizationFailure
			>[0];
		expect(getSummarizationFailure(mk("error", ""), "s")).toBeTruthy();
		expect(getSummarizationFailure(mk("length", "partial"), "s")).toContain("token cap");
		expect(getSummarizationFailure(mk("end_turn", ""), "s")).toContain("no summary text");
		expect(getSummarizationFailure(mk("end_turn", "ok summary"), "s")).toBeUndefined();
	});
});

function sessionEntryToMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type !== "message") return [];
	return [entry.message as unknown as AgentMessage];
}
