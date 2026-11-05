import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	compactionThreshold,
	estimateTokens,
	generateSummaryWithUsage,
	prepareCompaction,
	summaryHardLimitTokens,
} from "../src/core/compaction/index.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/core/compaction/utils.ts";
import { type SessionEntry, SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";

// Deterministic pseudo-random generator, so failures reproduce.
let seed = 12345;
function rand(): number {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}
function pick<T>(items: T[]): T {
	return items[Math.floor(rand() * items.length)];
}

const usage = (input: number, output = 10): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "a",
		provider: "p",
		model: "m",
		usage: usage(0, 0),
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function randomSession(): SessionManager {
	const manager = SessionManager.inMemory();
	const turns = 1 + Math.floor(rand() * 25);
	let t = 1;
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({
			role: "user",
			content: "u".repeat(Math.floor(rand() ** 3 * 80_000) + 1),
			timestamp: t++,
		});
		const steps = Math.floor(rand() * 4);
		for (let s = 0; s < steps; s++) {
			const id = `call-${turn}-${s}`;
			manager.appendMessage(
				assistant("", {
					content: [{ type: "toolCall", id, name: pick(["read", "bash", "edit"]), arguments: { path: `f${s}` } }],
					stopReason: "toolUse",
					timestamp: t++,
				}),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "r".repeat(Math.floor(rand() ** 3 * 120_000) + 1) }],
				timestamp: t++,
			});
		}
		if (rand() < 0.1) manager.appendModelChange("p", "m");
		const withUsage = rand() < 0.5;
		manager.appendMessage(
			assistant("a".repeat(Math.floor(rand() ** 2 * 20_000) + 1), {
				timestamp: t++,
				...(withUsage ? { usage: usage(Math.floor(rand() * 400_000)) } : {}),
			}),
		);
		if (rand() < 0.15) {
			const branch = manager.getBranch();
			const kept = pick(branch.filter((entry) => entry.type === "message"));
			manager.appendCompaction("prior checkpoint", kept.id, 1000);
		}
	}
	return manager;
}

describe("compaction invariants over randomized sessions", () => {
	it("prepares cuts that keep tool pairs, lose no messages, and respect the retention bound", () => {
		let prepared = 0;
		for (let iteration = 0; iteration < 3000; iteration++) {
			const manager = randomSession();
			const entries = manager.getBranch();
			const window = pick([8_192, 20_000, 32_768, 128_000, 200_000, 1_000_000]);
			const settings = {
				enabled: true,
				reserveTokens: pick([1_000, 2_000, 16_384, 50_000]),
				keepRecentTokens: pick([0, 1, 2_000, 20_000, 100_000]),
			};
			const prefixTokens = pick([0, 500, 12_000]);
			const pendingTokens = pick([0, 3_000, 60_000]);
			const preparation = prepareCompaction(entries, settings, window, { prefixTokens, pendingTokens });
			if (!preparation) continue;
			prepared++;
			const firstKeptIndex = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
			expect(firstKeptIndex).toBeGreaterThanOrEqual(0);
			// Never keep a tool result without its call: the first context-visible kept entry is a cut point.
			const firstVisible = entries
				.slice(firstKeptIndex)
				.find((entry) => sessionEntryToContextMessages(entry).length > 0);
			if (firstVisible && firstVisible.type === "message") expect(firstVisible.message.role).not.toBe("toolResult");

			// No message is lost or duplicated between summarized, prefix, and kept spans.
			let prevCompaction = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i].type === "compaction") {
					prevCompaction = i;
					break;
				}
			}
			let boundary = 0;
			if (prevCompaction >= 0) {
				const prev = entries[prevCompaction] as Extract<SessionEntry, { type: "compaction" }>;
				const keptIndex = entries.findIndex((entry) => entry.id === prev.firstKeptEntryId);
				boundary = keptIndex >= 0 ? keptIndex : prevCompaction + 1;
			}
			const span = entries
				.slice(boundary)
				.filter((entry) => entry.type !== "compaction")
				.flatMap((entry) => sessionEntryToContextMessages(entry).slice(0, 1));
			const kept = entries
				.slice(firstKeptIndex)
				.filter((entry) => entry.type !== "compaction")
				.flatMap((entry) => sessionEntryToContextMessages(entry).slice(0, 1));
			expect([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages, ...kept]).toEqual(span);
			expect(preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length).toBeGreaterThan(0);
			if (preparation.isSplitTurn) expect(preparation.turnPrefixMessages.length).toBeGreaterThan(0);

			// Retention respects the bound unless only the minimal suffix remains.
			const threshold = compactionThreshold(window, settings);
			const maxKeep = Math.max(
				0,
				Math.min(
					Math.floor(threshold * 0.5),
					threshold - prefixTokens - pendingTokens - summaryHardLimitTokens(window),
				),
			);
			const keptTokens = kept.reduce((sum, message) => sum + estimateTokens(message), 0);
			const cutPointIndexes = entries
				.map((entry, index) => ({ entry, index }))
				.filter(
					({ entry, index }) =>
						index >= boundary &&
						entry.type !== "compaction" &&
						sessionEntryToContextMessages(entry).some((message) => message.role !== "toolResult"),
				)
				.map(({ index }) => index);
			const latestCut = cutPointIndexes.at(-1) ?? firstKeptIndex;
			const firstVisibleIndex = entries.findIndex(
				(entry, index) => index >= firstKeptIndex && sessionEntryToContextMessages(entry).length > 0,
			);
			if (keptTokens > maxKeep) expect(firstVisibleIndex).toBe(latestCut);
		}
		expect(prepared).toBeGreaterThan(500);
	});

	it("sizes summary requests to the window and bounds requests under random provider behavior", async () => {
		let multiRequestRuns = 0;
		for (let iteration = 0; iteration < 300; iteration++) {
			const window = pick([20_000, 32_768, 128_000]);
			const model: Model<string> = {
				id: "m",
				name: "m",
				api: "a",
				provider: "p",
				baseUrl: "https://example.invalid",
				reasoning: rand() < 0.5,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: window,
				maxTokens: pick([2_000, 8_192, window]),
			};
			const messages: AgentMessage[] = [];
			const count = 1 + Math.floor(rand() * 30);
			for (let i = 0; i < count; i++) {
				messages.push({
					role: "user",
					content: `q${i} ${"x".repeat(Math.floor(rand() ** 2 * 60_000))}`,
					timestamp: i,
				});
				messages.push({ ...assistant(`a${i}`), timestamp: i } as AgentMessage);
			}
			const mode = pick(["ok", "flaky-length", "always-length", "flaky-overflow", "long-summary"]);
			let requests = 0;
			const streamFn: StreamFn = (_m, context, options) => {
				requests++;
				const text = JSON.stringify(context.messages);
				const promptTokens = Math.ceil((SUMMARIZATION_SYSTEM_PROMPT.length + text.length) / 3);
				// Every request fits the window by the planning estimate (JSON escaping adds a little).
				expect(promptTokens * 0.97 + (options?.maxTokens ?? 0)).toBeLessThanOrEqual(window);
				let message: AssistantMessage;
				const roll = rand();
				if (mode === "always-length" || (mode === "flaky-length" && roll < 0.4)) {
					message = assistant("partial", { stopReason: "length", usage: usage(10, 500) });
				} else if (mode === "flaky-overflow" && roll < 0.3) {
					message = assistant("", {
						stopReason: "error",
						errorMessage: "prompt is too long: 9 tokens > 8 maximum",
					});
				} else if (mode === "long-summary") {
					message = assistant(`## Goal\n${"w ".repeat(Math.floor(rand() * 40_000))}`);
				} else {
					message = assistant(`## Goal\nsummary ${requests}`);
				}
				const stream = createAssistantMessageEventStream();
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else if (message.stopReason !== "pending") {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
				stream.end(message);
				return stream;
			};
			try {
				const result = await generateSummaryWithUsage(
					messages,
					model,
					undefined,
					"k",
					undefined,
					undefined,
					undefined,
					rand() < 0.3 ? "## Goal\nprevious" : undefined,
					model.reasoning ? pick(["off", "minimal", "high", "max"]) : undefined,
					streamFn,
				);
				expect(result.text.length).toBeGreaterThan(0);
				expect(mode).not.toBe("always-length");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect(["always-length", "flaky-length", "flaky-overflow"]).toContain(mode);
			}
			// Bounded: chunks times (two attempts plus bounded recovery) plus one condense pass.
			expect(requests).toBeLessThan(400);
			if (requests > 2) multiRequestRuns++;
		}
		// Chunking, recovery, and condensing paths were exercised, not only single requests.
		expect(multiRequestRuns).toBeGreaterThan(100);
	});
});
