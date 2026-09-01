import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results with a head/marker/tail splice", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		// Head/marker/tail: leading portion, a middle-pruned marker, and a trailing portion.
		expect(result).toContain("[... middle truncated");
		expect(result).not.toContain("x".repeat(3000));
		// Head (80% of 2000 = 1600) is present.
		expect(result).toContain("x".repeat(1600));
		// Tail (20% of 2000 = 400) is preserved at the end.
		expect(result.trimEnd().endsWith("x".repeat(400))).toBe(true);
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("bounds combined tool-result text blocks before joining them", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [
					{ type: "text", text: "a".repeat(1500) },
					{ type: "text", text: "b".repeat(1500) },
				],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		// Total 3000 chars, head=1600 (1500 'a' + 100 'b'), tail=400 'b'.
		expect(result).toContain("a".repeat(1500));
		expect(result).toContain("[... middle truncated");
		// Tail preserves the last 400 characters.
		expect(result.trimEnd().endsWith("b".repeat(400))).toBe(true);
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
