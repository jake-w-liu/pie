import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { generateSummaryWithUsage } from "../src/core/compaction/index.ts";

// Capture the context and request options passed to the LLM so tests can assert
// the cache-reusing request shape.
let capturedContext:
	| {
			systemPrompt?: string;
			messages: Array<{ role: string; content: unknown }>;
			tools?: unknown[];
	  }
	| undefined;
let capturedOptions: Record<string, unknown> | undefined;

describe("generateSummaryWithUsage cache-reuse path", () => {
	it("replays the live system prompt, tools, and messages with a trailing instruction as a prefix", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "Please check the foo module", timestamp: 1 } as AgentMessage,
			{ role: "assistant", content: [{ type: "text", text: "On it." }], timestamp: 2 } as AgentMessage,
		];
		const tools = [{ name: "bash", description: "run a command", parameters: {} }];

		// A fake model only needs the reasoning flag for option building.
		const model = { reasoning: false, maxTokens: 8192 } as Model<any>;

		// streamFn receives (model, context, options); record both, then produce a summary.
		const streamFn = async (_m: Model<any>, context: unknown, options: unknown) => {
			capturedContext = context as typeof capturedContext;
			capturedOptions = (options ?? {}) as Record<string, unknown>;
			return {
				result: () => ({
					stopReason: "stop" as const,
					content: [{ type: "text" as const, text: "## Goal\nCache test summary" }],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 20,
						cacheWrite: 0,
						totalTokens: 35,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				}),
			};
		};
		const typedStreamFn = streamFn as never;

		const result = await generateSummaryWithUsage(
			messages,
			model,
			2000,
			undefined, // apiKey
			undefined, // headers
			undefined, // signal
			undefined, // customInstructions
			undefined, // previousSummary
			undefined, // thinkingLevel
			typedStreamFn,
			undefined, // env
			undefined, // retry
			undefined, // callbacks
			undefined, // sessionId
			"live system prompt for the coding agent",
			tools as never,
		);

		expect(result.text).toBe("## Goal\nCache test summary");
		// Cache-reuse path: context uses the provided system prompt, not the summarizer default.
		expect(capturedContext?.systemPrompt).toBe("live system prompt for the coding agent");
		// The conversation messages are replayed as real messages (not a serialized blob).
		expect(capturedContext?.messages.length).toBe(3); // 2 conversation + 1 trailing instruction
		expect(capturedContext?.messages[0]).toMatchObject({ role: "user" });
		expect(capturedContext?.messages[1]).toMatchObject({ role: "assistant" });
		// Final user message carries the compaction instruction, not a `<conversation>` wrapper.
		const finalMessage = capturedContext?.messages[2] as { role: string; content: unknown };
		expect(finalMessage.role).toBe("user");
		expect(JSON.stringify(finalMessage.content)).not.toContain("<conversation>");
		expect(JSON.stringify(finalMessage.content)).toContain("compaction engine");
		// Tools are forwarded for prefix alignment.
		expect(capturedContext?.tools).toEqual(tools);
		// Summarization must never write a cache entry (only reuse the existing warm prefix).
		expect(capturedOptions?.cacheRetention).toBe("none");
	});
});
