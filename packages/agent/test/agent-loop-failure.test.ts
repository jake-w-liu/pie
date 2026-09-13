/**
 * Regression tests: agentLoop/agentLoopContinue must terminate their
 * EventStream when the underlying run rejects (previously `void run.then(end)`
 * with no rejection handler caused an unhandled rejection plus a stream that
 * never ended, hanging async iteration and result() forever).
 */
import type { Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

describe("agentLoop failure close-out", () => {
	it("ends the stream and settles result() when the run rejects", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: () => {
					throw new Error("boom: convert failed");
				},
			};

			const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, () => {
				throw new Error("streamFn must not be reached");
			});

			const events: unknown[] = [];
			await withTimeout(
				(async () => {
					for await (const event of stream) {
						events.push(event);
					}
				})(),
				5000,
				"agentLoop iteration to end",
			);
			const messages = await withTimeout(stream.result(), 5000, "agentLoop result() to settle");

			expect(Array.isArray(messages)).toBe(true);
			// Allow the event loop to flush any late rejections, then assert none occurred.
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});
});

describe("agentLoopContinue failure close-out", () => {
	it("ends the stream and settles result() when the run rejects", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const context: AgentContext = {
				systemPrompt: "",
				messages: [createUserMessage("Hello")],
				tools: [],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
			};

			const stream = agentLoopContinue(context, config, undefined, () => {
				throw new Error("boom: provider failed");
			});

			const events: unknown[] = [];
			await withTimeout(
				(async () => {
					for await (const event of stream) {
						events.push(event);
					}
				})(),
				5000,
				"agentLoopContinue iteration to end",
			);
			const messages = await withTimeout(stream.result(), 5000, "agentLoopContinue result() to settle");

			expect(Array.isArray(messages)).toBe(true);
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});
});
