import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadroomController } from "../../src/core/headroom.ts";
import { createHarness, type Harness } from "./harness.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: ZERO_COST,
	};
}

describe("AgentSession mid-run compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts at 87% between tool turns before the next provider request", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Return text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: undefined };
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 600, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "mid-run summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const seededAt = Date.now() - 10000;
		harness.sessionManager.appendMessage({ role: "user", content: "old context", timestamp: seededAt });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old response", { timestamp: seededAt + 1 }),
			usage: usage(10),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let secondRequestContext = "";
		harness.setResponses([
			{
				...fauxAssistantMessage(fauxToolCall("echo", { text: "tool result" }), { stopReason: "toolUse" }),
				usage: usage(87),
			},
			(context) => {
				secondRequestContext = JSON.stringify(context.messages);
				return { ...fauxAssistantMessage("done"), usage: usage(30) };
			},
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: true }),
		);
		expect(secondRequestContext).toContain("mid-run summary");
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});

	it("projects fresh results as raw (matching the transform) without mutating stores", async () => {
		const headroom = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const largeResultTool: AgentTool = {
			name: "large-result",
			label: "Large result",
			description: "Return compressible text",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "compressible line\n".repeat(10000) }],
				details: undefined,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			tools: [largeResultTool],
			projectContextForCompaction: (messages) => headroom.projectContext(messages, true),
		});
		harnesses.push(harness);
		let compactionsBeforeSecondRequest = -1;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large-result", {}), { stopReason: "toolUse" }),
			() => {
				compactionsBeforeSecondRequest = harness.eventsOfType("compaction_start").length;
				harness.settingsManager.applyOverrides({ compaction: { enabled: false } });
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
		// A fresh result produced by the current turn is delivered raw on its first
		// request (Headroom only compresses historical results the model already
		// consumed), so the projection estimates the raw size and compaction fires
		// before the oversized request.
		expect(compactionsBeforeSecondRequest).toBe(1);
		expect(headroom.getStoreStats().entries).toBe(0);
		expect(headroom.getSessionStats().attemptedSegments).toBe(0);
	});

	it("compacts a large result that Headroom intentionally skips", async () => {
		const headroom = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const skippedTool: AgentTool = {
			name: "subagent",
			label: "Subagent",
			description: "Return coordination output",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "uncompressed coordination output ".repeat(10000) }],
				details: undefined,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			tools: [skippedTool],
			projectContextForCompaction: (messages) => headroom.projectContext(messages, true),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "skipped result summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "overflow", aborted: false, willRetry: true }),
		);
		expect(harness.eventsOfType("context_limit")).toContainEqual(expect.objectContaining({ contextWindow: 1000 }));
	});

	it("stops before the next request when required compaction is cancelled", async () => {
		const headroom = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const skippedTool: AgentTool = {
			name: "subagent",
			label: "Subagent",
			description: "Return coordination output",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "uncompressed coordination output ".repeat(10000) }],
				details: undefined,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			tools: [skippedTool],
			projectContextForCompaction: (messages) => headroom.projectContext(messages, true),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "overflow", aborted: true, willRetry: false }),
		);
		expect(harness.eventsOfType("context_limit")).toContainEqual(expect.objectContaining({ contextWindow: 1000 }));
	});

	it("uses a fresh size estimate for a post-compaction zero-usage tool turn", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 500, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const staleAssistant = { ...fauxAssistantMessage("stale"), usage: usage(490) };
		const staleUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: "before compaction",
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		harness.sessionManager.appendCompaction("existing summary", staleUserId, 490);

		const zeroUsageAssistant = {
			...fauxAssistantMessage(fauxToolCall("missing", {}), { stopReason: "toolUse" }),
			usage: usage(0),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "missing",
			toolName: "missing",
			content: [{ type: "text", text: "x".repeat(10000) }],
			isError: true,
			timestamp: Date.now(),
		};
		const messages: AgentMessage[] = [staleAssistant, zeroUsageAssistant, toolResult];
		const sessionInternals = harness.session as unknown as {
			_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
		};
		const compactSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await harness.session.agent.prepareNextTurnWithContext?.(
			{
				message: zeroUsageAssistant,
				toolResults: [toolResult],
				context: { systemPrompt: "test", messages, tools: [] },
				newMessages: [zeroUsageAssistant, toolResult],
			},
			undefined,
		);

		expect(compactSpy).toHaveBeenCalledWith("overflow", true);
	});
});
