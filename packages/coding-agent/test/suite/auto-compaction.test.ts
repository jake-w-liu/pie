import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { generateBranchSummary } from "../../src/core/compaction/branch-summarization.ts";
import { type CompactionPreparation, compact, generateSummaryWithUsage } from "../../src/core/compaction/index.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const settings = { enabled: true, reserveTokens: 2000, keepRecentTokens: 2000 };
let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function seedLargeHistory(h: Harness): void {
	const model = h.getModel();
	const messages: Message[] = [
		{ role: "user", content: "old history ".repeat(5000), timestamp: 1 },
		fauxAssistantMessage("old answer ".repeat(1000), { timestamp: 2 }),
		{ role: "user", content: "recent request", timestamp: 3 },
		{
			...fauxAssistantMessage("recent answer ".repeat(700), { timestamp: 4 }),
			provider: model.provider,
			model: model.id,
			usage: {
				input: 18000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 19000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	];
	for (const message of messages) h.sessionManager.appendMessage(message);
	h.session.agent.state.messages = messages;
}

function captureSummaryInputs(h: Harness): number[] {
	const inputs: number[] = [];
	const streamFn = h.session.agent.streamFunction;
	if (!streamFn) throw new Error("Missing faux stream function");
	h.session.agent.streamFunction = async (model, context, options) => {
		const stream = await streamFn(model, context, options);
		inputs.push((await stream.result()).usage.input);
		return stream;
	};
	return inputs;
}

const largeTool: AgentTool = {
	name: "large_result",
	label: "large result",
	description: "Return test context",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "large output ".repeat(8000) }], details: {} };
	},
};

describe("automatic compaction", () => {
	it("retains next-turn messages arriving after the preflight snapshot", async () => {
		let queued = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (queued) return;
						queued = true;
						await harness!.session.sendCustomMessage(
							{
								customType: "late-next-turn",
								content: "preserve this input",
								display: false,
								details: undefined,
							},
							{ deliverAs: "nextTurn" },
						);
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "late-next-turn",
			),
		).toHaveLength(1);
	});

	it("accounts for completed summary calls even if the turn-prefix summary fails", async () => {
		harness = await createHarness({ settings: { compaction: settings, retry: { enabled: false } } });
		seedLargeHistory(harness);
		const before = harness.session.getSessionStats().tokens.input;
		const inputs = captureSummaryInputs(harness);
		const success = fauxAssistantMessage("history summary");
		const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid API key" });
		harness.setResponses([success, failure]);
		await expect(harness.session.compact()).rejects.toThrow("invalid API key");
		expect(harness.faux.state.callCount).toBe(2);
		expect(inputs.every((input) => input > 0)).toBe(true);
		expect(harness.session.getSessionStats().tokens.input - before).toBe(inputs.reduce((a, b) => a + b, 0));
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("includes retry usage once in summary results and session totals", async () => {
		harness = await createHarness({
			settings: { compaction: settings, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		seedLargeHistory(harness);
		const before = harness.session.getSessionStats().tokens.input;
		const inputs = captureSummaryInputs(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("history summary"),
			fauxAssistantMessage("turn summary"),
		]);
		const result = await harness.session.compact();
		expect(harness.faux.state.callCount).toBe(3);
		expect(inputs.every((input) => input > 0)).toBe(true);
		const total = inputs.reduce((a, b) => a + b, 0);
		expect(result.usage?.input).toBe(total);
		expect(harness.session.getSessionStats().tokens.input - before).toBe(total);
	});

	it("rejects a branch summary with no available input budget without calling the provider", async () => {
		harness = await createHarness({ models: [{ id: "small", contextWindow: 8192 }] });
		harness.sessionManager.appendMessage({ role: "user", content: "branch context", timestamp: 1 });
		const result = await generateBranchSummary(harness.sessionManager.getBranch(), {
			model: harness.getModel(),
			signal: new AbortController().signal,
			streamFn: harness.session.agent.streamFunction,
		});
		expect(result.error).toContain("No input budget");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("includes an extension's system-prompt overhead in the final request limit", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 10000 }],
			settings: { compaction: settings },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "x".repeat(40000) }));
				},
			],
		});
		await harness.session.prompt("hello");
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("context_limit")).toHaveLength(1);
	});

	it("does not trust old low usage after historical context expands", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings },
			projectContextForCompaction: (messages) => messages,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		seedLargeHistory(harness);
		const latest = harness.session.agent.state.messages.at(-1);
		if (latest?.role !== "assistant") throw new Error("Missing fixture assistant");
		latest.usage = { ...latest.usage, input: 1000, output: 0, totalTokens: 1000 };
		await expect(harness.session.prompt("hello")).rejects.toThrow();
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("keeps full file tracking outside the bounded context-visible checkpoint", async () => {
		harness = await createHarness({ settings: { compaction: { ...settings, keepRecentTokens: 1 } } });
		const files = Array.from({ length: 5000 }, (_, i) => `${i}/${"path/".repeat(20)}file.ts`);
		harness.sessionManager.branchWithSummary(null, "completed branch", { readFiles: files, modifiedFiles: [] });
		harness.sessionManager.appendMessage({ role: "user", content: "retained request", timestamp: Date.now() });
		harness.setResponses([fauxAssistantMessage("summary")]);
		const result = await harness.session.compact();
		expect(result.summary.length).toBeLessThanOrEqual(settings.reserveTokens * 4);
		expect(result.details).toMatchObject({ readFiles: files.toSorted(), modifiedFiles: [] });
		expect(result.summary).toContain("summary metadata");
	});

	it("bounds oversized raw history instead of overflowing its own summary request", async () => {
		harness = await createHarness();
		const messages: Message[] = [{ role: "user", content: "inspect the results", timestamp: 1 }];
		for (let i = 0; i < 12; i++) {
			messages.push(fauxAssistantMessage(fauxToolCall("read", { path: `file-${i}` }, { id: `call-${i}` })));
			messages.push({
				role: "toolResult",
				toolName: "read",
				toolCallId: `call-${i}`,
				isError: false,
				content: [{ type: "text", text: `${"x".repeat(64000)}final-diagnostic-${i}` }],
				timestamp: 2,
			});
		}
		let sentCharacters = 0;
		harness.setResponses([
			(context) => {
				const payload = JSON.stringify(context);
				sentCharacters = payload.length;
				expect(payload).toContain("final-diagnostic-11");
				return fauxAssistantMessage("summary of large results");
			},
		]);
		const result = await generateSummaryWithUsage(
			messages,
			harness.getModel(),
			16384,
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			harness.session.agent.streamFunction,
			undefined,
			undefined,
			undefined,
			undefined,
			"live system prompt",
			[],
		);
		expect(result.text).toBe("summary of large results");
		expect(sentCharacters).toBeLessThan(128000 * 4);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("preserves the previous checkpoint when only a turn prefix needs summarizing", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("new prefix summary")]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [{ role: "user", content: "continue the task", timestamp: 1 }],
			isSplitTurn: true,
			tokensBefore: 10000,
			previousSummary: "Critical decision: preserve the database and do not deploy.",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings,
		};
		const result = await compact(
			preparation,
			harness.getModel(),
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			harness.session.agent.streamFunction,
		);
		expect(result.summary).toContain(preparation.previousSummary);
		expect(result.summary).toContain("new prefix summary");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("holds the session busy and cancels pre-prompt compaction through abort", async () => {
		const entered = deferred();
		const release = deferred();
		let signal: AbortSignal | undefined;
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						signal = event.signal;
						entered.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		seedLargeHistory(harness);
		const prompt = harness.session.prompt("new request").catch((error: unknown) => error);
		await entered.promise;
		const idleDuringCompaction = harness.session.isIdle;
		const abort = harness.session.abort();
		const aborted = signal?.aborted;
		release.resolve();
		await Promise.all([prompt, abort]);
		expect(idleDuringCompaction).toBe(false);
		expect(aborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not send a new prompt when required pre-prompt compaction is cancelled", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		seedLargeHistory(harness);
		const result = await harness.session.prompt("new request").catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).not.toContain("new request");
	});

	it("rejects an oversized new prompt before its first provider request", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings },
		});
		const result = await harness.session.prompt("oversized input ".repeat(6000)).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("checks steering accepted during preflight before the initial provider request", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						await harness!.session.steer("oversized steering ".repeat(6000));
					});
				},
			],
		});
		await harness.session.prompt("short request");
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("context_limit")).toHaveLength(1);
		expect(getUserTexts(harness).some((text) => text.startsWith("oversized steering"))).toBe(true);
	});

	it("honors synchronous cancellation from compaction_start", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings },
		});
		seedLargeHistory(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") harness!.session.abortCompaction();
		});
		await harness.session.prompt("new request").catch((error: unknown) => error);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ aborted: true, willRetry: false }),
		]);
	});

	it("queues a concurrent prompt behind one preflight compaction", async () => {
		const entered = deferred();
		const release = deferred();
		let compactions = 0;
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 20000 }],
			settings: { compaction: settings },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						compactions++;
						entered.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		seedLargeHistory(harness);
		const first = harness.session.prompt("first").catch((error: unknown) => error);
		await entered.promise;
		await harness.session.prompt("second", { streamingBehavior: "followUp" });
		expect(harness.session.getFollowUpMessages()).toEqual(["second"]);
		release.resolve();
		await first;
		expect(compactions).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("routes truncated tool calls through one bounded recovery", async () => {
		let compactions = 0;
		harness = await createHarness({
			settings: { compaction: { ...settings, keepRecentTokens: 1 }, retry: { enabled: false } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactions++;
						return {
							compaction: {
								summary: "retained task",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "length" }),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "length" }),
			fauxAssistantMessage("must not reach a third attempt"),
		]);
		await harness.session.prompt("do the task");
		expect(compactions).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain(
			"after one compact-and-retry attempt",
		);
	});

	it.each(["before", "during"])(
		"does not lose steering queued %s a cancelled between-tool compaction",
		async (timing) => {
			harness = await createHarness({
				models: [{ id: "small", contextWindow: 20000 }],
				tools: [largeTool],
				settings: { compaction: settings, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => {
							if (timing === "during") await harness!.session.steer("keep this instruction");
							return { cancel: true };
						});
					},
				],
			});
			if (timing === "before") {
				harness.session.subscribe((event) => {
					if (event.type === "turn_end") void harness!.session.steer("keep this instruction");
				});
			}
			harness.setResponses([fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" })]);
			await harness.session.prompt("read the large result");
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("context_limit")).toHaveLength(1);
			// A message must either remain queued for delivery or be durably present in context.
			expect(
				harness.session.agent.hasQueuedMessages() || getUserTexts(harness).includes("keep this instruction"),
			).toBe(true);
		},
	);
});
