import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("branch summarization", () => {
	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});

	it("rejects branch summaries without text", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: response([{ type: "thinking", thinking: "internal only" }]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization failed: response contained no summary text");
	});

	it("includes large tool results at their bounded serialized size", async () => {
		const toolCallId = "branch-tool";
		const largeResult = `critical result ${"x".repeat(20_000)}`;
		const branchEntries: SessionEntry[] = [
			{
				type: "message",
				id: "branch-assistant",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				message: fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }, { id: toolCallId }), {
					stopReason: "toolUse",
				}),
			},
			{
				type: "message",
				id: "branch-result",
				parentId: "branch-assistant",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: largeResult }],
					isError: false,
					timestamp: 2,
				},
			},
		];
		let requestContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			requestContext = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(branchEntries, {
			model: { ...model, contextWindow: 5000 },
			reserveTokens: 1000,
			signal: new AbortController().signal,
			streamFn,
		});

		const prompt = JSON.stringify(requestContext?.messages);
		expect(prompt).toContain("[Tool result]: critical result");
		expect(prompt).toContain("more characters truncated");
	});

	it("carries file tracking forward from compaction details", async () => {
		const compactedEntries: SessionEntry[] = [
			{
				type: "compaction",
				id: "branch-compaction",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				summary: "Earlier work",
				firstKeptEntryId: "branch-user",
				tokensBefore: 1000,
				details: { readFiles: ["read-before.txt"], modifiedFiles: ["changed-before.ts"] },
			},
			entries[0]!,
		];
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		const result = await generateBranchSummary(compactedEntries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.readFiles).toEqual(["read-before.txt"]);
		expect(result.modifiedFiles).toEqual(["changed-before.ts"]);
		expect(result.summary).toContain("<read-files>\nread-before.txt\n</read-files>");
		expect(result.summary).toContain("<modified-files>\nchanged-before.ts\n</modified-files>");
	});
});
