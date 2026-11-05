import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import { generateSummaryWithUsage, summaryHardLimitTokens } from "../src/core/compaction/index.ts";
import { CONCISE_RETRY_NOTE } from "../src/core/compaction/summarization.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/core/compaction/utils.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const usage = (output = 10): Usage => ({
	input: 100,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 100 + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function response(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test",
		model: "test-model",
		usage: usage(stopReason === "length" ? 5000 : 10),
		stopReason,
		timestamp: Date.now(),
		...extra,
	};
}

type Step = AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined) => AssistantMessage);

interface Call {
	context: Context;
	options: SimpleStreamOptions | undefined;
	text: string;
}

/** A stream function that replays scripted responses and records every request. */
function scripted(steps: Step[]): { streamFn: StreamFn; calls: Call[] } {
	const calls: Call[] = [];
	const streamFn: StreamFn = (_model, context, options) => {
		const firstMessage = context.messages[0];
		const text =
			firstMessage?.role === "user" && Array.isArray(firstMessage.content)
				? firstMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("")
				: "";
		calls.push({ context, options, text });
		const step = steps[calls.length - 1];
		const message = step
			? typeof step === "function"
				? step(context, options)
				: step
			: response("", "error", { errorMessage: "no scripted response left" });
		const stream = createAssistantMessageEventStream();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else if (message.stopReason !== "pending") {
			stream.push({ type: "done", reason: message.stopReason, message });
		}
		stream.end(message);
		return stream;
	};
	return { streamFn, calls };
}

function model(overrides: Partial<Model<string>> = {}): Model<string> {
	return {
		id: "test-model",
		name: "Test model",
		api: "test-api",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

const reasoningModel = model({
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
});

function conversation(count: number, chars: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		messages.push({ role: "user", content: `request-${i} ${"x".repeat(chars)}`, timestamp: i * 2 });
		messages.push({ ...response(`answer-${i}`), timestamp: i * 2 + 1 } as AgentMessage);
	}
	return messages;
}

async function summarize(
	messages: AgentMessage[],
	targetModel: Model<string>,
	streamFn: StreamFn,
	options: {
		previousSummary?: string;
		thinkingLevel?: "off" | "minimal" | "medium" | "high" | "max";
		signal?: AbortSignal;
	} = {},
) {
	return generateSummaryWithUsage(
		messages,
		targetModel,
		16_384,
		"key",
		undefined,
		options.signal,
		undefined,
		options.previousSummary,
		options.thinkingLevel,
		streamFn,
	);
}

describe("summary requests", () => {
	it("send a serialized transcript under the summarizer prompt, without tools or cache writes", async () => {
		const { streamFn, calls } = scripted([response("## Goal\nsummary")]);
		const result = await summarize(conversation(1, 10), model(), streamFn);
		expect(result.text).toBe("## Goal\nsummary");
		expect(calls).toHaveLength(1);
		expect(calls[0].context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(calls[0].context.tools).toBeUndefined();
		expect(calls[0].context.messages).toHaveLength(1);
		expect(calls[0].text).toContain("<conversation>\n[User]: request-0");
		expect(calls[0].options?.cacheRetention).toBe("none");
		expect(calls[0].options?.sessionId).toBeTruthy();
	});

	it("use the model's output limit instead of a cap derived from reserveTokens", async () => {
		const { streamFn, calls } = scripted([response("## Goal\nsummary")]);
		await summarize(conversation(1, 10), reasoningModel, streamFn, { thinkingLevel: "high" });
		expect(calls[0].options?.maxTokens).toBe(128_000);
		expect(calls[0].options?.reasoning).toBe("high");
	});

	it("cap summary reasoning at high", async () => {
		const { streamFn, calls } = scripted([response("## Goal\nsummary")]);
		await summarize(conversation(1, 10), reasoningModel, streamFn, { thinkingLevel: "max" });
		expect(calls[0].options?.reasoning).toBe("high");
	});

	it("do not request reasoning when thinking is off", async () => {
		const { streamFn, calls } = scripted([response("## Goal\nsummary")]);
		await summarize(conversation(1, 10), reasoningModel, streamFn, { thinkingLevel: "off" });
		expect(calls[0].options).not.toHaveProperty("reasoning");
	});

	it("retry an output-limit stop once with reduced reasoning and a shorter-summary request", async () => {
		// Models where reasoning shares the output limit can spend it before the summary text.
		const { streamFn, calls } = scripted([response("partial", "length"), response("## Goal\nshort summary")]);
		const result = await summarize(conversation(2, 10), reasoningModel, streamFn, { thinkingLevel: "high" });
		expect(result.text).toBe("## Goal\nshort summary");
		expect(calls).toHaveLength(2);
		expect(calls[0].options?.reasoning).toBe("high");
		expect(calls[0].text).not.toContain(CONCISE_RETRY_NOTE);
		expect(calls[1].options?.reasoning).toBe("minimal");
		expect(calls[1].text).toContain(CONCISE_RETRY_NOTE);
		expect(result.usage.output).toBe(5000 + 10);
	});

	it("bound requests when a provider stops at its output limit regardless of input", async () => {
		const { streamFn, calls } = scripted(Array.from({ length: 50 }, () => response("partial", "length")));
		await expect(summarize(conversation(4, 10), reasoningModel, streamFn, { thinkingLevel: "high" })).rejects.toThrow(
			/Summarization failed: generation hit the output limit after 5000 tokens even with reduced reasoning/,
		);
		// Two attempts on the whole chunk, then two on its first half after the single allowed split.
		expect(calls).toHaveLength(4);
	});

	it("split a chunk after a context-overflow error and fold both halves", async () => {
		const { streamFn, calls } = scripted([
			response("", "error", { errorMessage: "prompt is too long: 1200000 tokens > 1000000 maximum" }),
			response("## Goal\nfirst half"),
			response("## Goal\nboth halves"),
		]);
		const result = await summarize(conversation(4, 10), reasoningModel, streamFn);
		expect(result.text).toBe("## Goal\nboth halves");
		expect(calls).toHaveLength(3);
		expect(calls[1].text).toContain("request-0");
		expect(calls[1].text).not.toContain("request-3");
		expect(calls[2].text).toContain("request-3");
		expect(calls[2].text).not.toContain("request-0 ");
		expect(calls[2].text).toContain("<previous-summary>\n## Goal\nfirst half\n</previous-summary>");
	});

	it("fold a history larger than one request into one rolling summary", async () => {
		const small = model({ contextWindow: 20_000, maxTokens: 2_000 });
		let index = 0;
		const { streamFn, calls } = scripted(
			Array.from({ length: 20 }, () => () => response(`## Goal\nsummary ${++index}`)),
		);
		const messages = conversation(12, 6_000);
		const result = await summarize(messages, small, streamFn, { previousSummary: "## Goal\nolder checkpoint" });
		expect(calls.length).toBeGreaterThan(1);
		expect(result.text).toBe(`## Goal\nsummary ${calls.length}`);
		expect(calls[0].text).toContain("<previous-summary>\n## Goal\nolder checkpoint\n</previous-summary>");
		for (let i = 1; i < calls.length; i++) {
			expect(calls[i].text).toContain(`<previous-summary>\n## Goal\nsummary ${i}\n</previous-summary>`);
		}
		for (const call of calls) {
			// The conservative chars/3 prompt estimate plus the requested output fits the window.
			const promptTokens = Math.ceil((SUMMARIZATION_SYSTEM_PROMPT.length + call.text.length) / 3);
			expect(promptTokens + (call.options?.maxTokens ?? 0)).toBeLessThanOrEqual(small.contextWindow);
		}
		const sent = calls.map((call) => call.text).join("\n");
		for (let i = 0; i < 12; i++) expect(sent).toContain(`request-${i} `);
	});

	it("truncate a single message larger than one request instead of failing", async () => {
		const small = model({ contextWindow: 20_000, maxTokens: 2_000 });
		const { streamFn, calls } = scripted([response("## Goal\nsummary")]);
		const messages: AgentMessage[] = [
			{ role: "user", content: `start ${"y".repeat(200_000)} final-marker`, timestamp: 1 },
		];
		const result = await summarize(messages, small, streamFn);
		expect(result.text).toBe("## Goal\nsummary");
		expect(calls).toHaveLength(1);
		expect(calls[0].text).toContain("start ");
		expect(calls[0].text).toContain("final-marker");
		expect(calls[0].text).toContain("middle truncated");
	});

	it("condense a summary longer than its hard limit once", async () => {
		const target = model();
		const longSummary = `## Goal\n${"detail ".repeat(summaryHardLimitTokens(target.contextWindow))}`;
		const { streamFn, calls } = scripted([response(longSummary), response("## Goal\ncondensed")]);
		const result = await summarize(conversation(1, 10), target, streamFn);
		expect(result.text).toBe("## Goal\ncondensed");
		expect(calls).toHaveLength(2);
		expect(calls[1].text).toContain("<checkpoint>");
		expect(calls[1].text).toContain("grown too long");
	});

	it("keep the complete summary when condensing fails", async () => {
		const target = model();
		const longSummary = `## Goal\n${"detail ".repeat(summaryHardLimitTokens(target.contextWindow))}`;
		const { streamFn } = scripted([
			response(longSummary),
			response("", "error", { errorMessage: "invalid request" }),
		]);
		const result = await summarize(conversation(1, 10), target, streamFn);
		expect(result.text).toBe(longSummary);
	});

	it("reject tool calls and empty responses", async () => {
		const toolCall = response("");
		toolCall.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }];
		toolCall.stopReason = "toolUse";
		await expect(summarize(conversation(1, 10), model(), scripted([toolCall]).streamFn)).rejects.toThrow(
			"Summarization attempted to call a tool",
		);
		await expect(summarize(conversation(1, 10), model(), scripted([response("  ")]).streamFn)).rejects.toThrow(
			"response contained no summary text",
		);
	});

	it("surface non-recoverable provider errors", async () => {
		const { streamFn, calls } = scripted([response("", "error", { errorMessage: "invalid API key" })]);
		await expect(summarize(conversation(1, 10), model(), streamFn)).rejects.toThrow(
			"Summarization failed: invalid API key",
		);
		expect(calls).toHaveLength(1);
	});

	it("propagate aborts as AbortError", async () => {
		const controller = new AbortController();
		const { streamFn } = scripted([
			() => {
				controller.abort();
				return response("", "aborted", { errorMessage: "Request was aborted" });
			},
		]);
		await expect(
			summarize(conversation(1, 10), model(), streamFn, { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("branch summary requests", () => {
	it("forward the session thinking level and use the model's output limit", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "explore the branch", timestamp: 1 });
		manager.appendMessage({ ...response("explored"), timestamp: 2 } as AssistantMessage);
		const { streamFn, calls } = scripted([response("## Goal\nbranch summary")]);
		const result = await generateBranchSummary(manager.getBranch(), {
			model: reasoningModel,
			signal: new AbortController().signal,
			thinkingLevel: "medium",
			streamFn,
		});
		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("branch summary");
		expect(calls[0].options?.reasoning).toBe("medium");
		expect(calls[0].options?.maxTokens).toBe(128_000);
	});

	it("report an output-limit failure as an error result after the reduced-reasoning retry", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "explore the branch", timestamp: 1 });
		const { streamFn, calls } = scripted([response("partial", "length"), response("partial", "length")]);
		const result = await generateBranchSummary(manager.getBranch(), {
			model: reasoningModel,
			signal: new AbortController().signal,
			thinkingLevel: "high",
			streamFn,
		});
		expect(result.error).toContain("Branch summarization failed: generation hit the output limit");
		expect(calls).toHaveLength(2);
	});
});
