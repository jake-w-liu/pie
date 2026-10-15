import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A response that, like a real provider request, ends only when its signal aborts. */
function responseUntilAborted(started: () => void): FauxResponseStep {
	return async (_context, options) => {
		started();
		await new Promise<void>((resolve) => {
			if (options?.signal?.aborted) resolve();
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage("aborted response");
	};
}

/** Resolve with the operation's outcome, or "pending" if it is still running after `ms`. */
async function settleWithin(operation: Promise<unknown>, ms: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Promise<string>((resolve) => {
		timer = setTimeout(() => resolve("pending"), ms);
	});
	try {
		return await Promise.race([
			operation.then(
				() => "resolved",
				(error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
			),
			pending,
		]);
	} finally {
		clearTimeout(timer);
	}
}

function describeMessage(message: AgentMessage): string {
	return message.role === "custom" || message.role === "assistant"
		? `${message.role}:${getMessageText(message)}`
		: message.role;
}

describe("session operation exclusion", () => {
	it("keeps manual compaction busy and rejects concurrent tree navigation", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 50 } },
		});
		harnesses.push(harness);
		const { session, sessionManager } = harness;
		const model = harness.getModel();
		const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
		const assistant = (text: string) => ({
			...fauxAssistantMessage(text),
			provider: model.provider,
			model: model.id,
		});
		const targetId = sessionManager.appendMessage(user("root question ".repeat(20)));
		sessionManager.appendMessage(assistant("root answer ".repeat(20)));
		sessionManager.appendMessage(user("later question ".repeat(20)));
		sessionManager.appendMessage(assistant("later answer ".repeat(20)));
		sessionManager.appendMessage(user("latest question ".repeat(20)));
		sessionManager.appendMessage(assistant("latest answer ".repeat(20)));
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		const originalLeaf = sessionManager.getLeafId();

		const started = deferred();
		const release = deferred();
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("history summary");
			},
			fauxAssistantMessage("turn prefix summary"),
		]);

		const compacting = session.compact();
		await started.promise;
		expect(session.isCompacting).toBe(true);
		expect(session.isIdle).toBe(false);
		let idleSettled = false;
		const waiting = session.waitForIdle().then(() => {
			idleSettled = true;
		});
		await Promise.resolve();
		expect(idleSettled).toBe(false);
		await expect(session.navigateTree(targetId)).rejects.toThrow("current session operation");
		expect(sessionManager.getLeafId()).toBe(originalLeaf);

		release.resolve();
		await compacting;
		await waiting;
		expect(session.isIdle).toBe(true);
	});

	it("keeps the active run wait promise when a run starts during agent_settled", async () => {
		const settledEntered = deferred();
		const releaseSettled = deferred();
		const secondStarted = deferred();
		const releaseSecond = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						settledEntered.resolve();
						await releaseSettled.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		const first = harness.session.prompt("first");
		await settledEntered.promise;

		// A second run begins while the settled handler is still awaiting.
		harness.appendResponses([
			async () => {
				secondStarted.resolve();
				await releaseSecond.promise;
				return fauxAssistantMessage("second");
			},
		]);
		const second = harness.session.prompt("second");
		await secondStarted.promise;
		releaseSettled.resolve();
		await first;

		// The settling run must leave the live run's wait promise intact, otherwise an operation that
		// awaits it (manual compaction) resumes while the live run is still writing.
		expect(Reflect.get(harness.session, "_isAgentRunActive")).toBe(true);
		expect(Reflect.get(harness.session, "_agentRunWaitPromise")).toBeDefined();

		releaseSecond.resolve();
		await second;
		expect(harness.session.isIdle).toBe(true);
	}, 30_000);

	it("finishes manual compaction when an agent_settled handler triggers a turn, then runs that turn", async () => {
		let armed = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (!armed) return;
						armed = false;
						pi.sendMessage({ customType: "late", content: "late result", display: false }, { triggerTurn: true });
					});
				},
			],
		});
		harnesses.push(harness);
		const { session } = harness;
		harness.setResponses([fauxAssistantMessage("seed answer ".repeat(200))]);
		await session.prompt("seed ".repeat(400));

		const runStarted = deferred();
		harness.setResponses([
			responseUntilAborted(runStarted.resolve),
			fauxAssistantMessage("## Goal\nsummary"),
			fauxAssistantMessage("reply to late"),
		]);
		const run = session.prompt("second");
		await runStarted.promise;
		const streamingAtCompactionStart: boolean[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") streamingAtCompactionStart.push(session.isStreaming);
		});

		armed = true;
		const compacting = session.compact();
		await run;
		expect(await settleWithin(compacting, 5_000)).toBe("resolved");
		expect(streamingAtCompactionStart).toEqual([false]);

		// The triggered turn starts once compaction has finished, on the compacted context.
		await session.waitForIdle();
		const context = session.messages.map(describeMessage);
		expect(context.slice(-2)).toEqual(["custom:late result", "assistant:reply to late"]);
		expect(context[0]).toBe("compactionSummary");
		expect(harness.getPendingResponseCount()).toBe(0);
	}, 30_000);

	it("starts a turn triggered during tree navigation only after navigation commits", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { session, sessionManager } = harness;
		harness.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
		await session.prompt("u1");
		await session.prompt("u2");
		const target = sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && getMessageText(entry.message) === "a1");
		expect(target).toBeDefined();

		const summaryStarted = deferred();
		const releaseSummary = deferred();
		harness.setResponses([
			async () => {
				summaryStarted.resolve();
				await releaseSummary.promise;
				return fauxAssistantMessage("branch summary");
			},
			fauxAssistantMessage("reply to notice"),
		]);
		const navigating = session.navigateTree(target!.id, { summarize: true });
		await summaryStarted.promise;

		const sent = session.sendCustomMessage(
			{ customType: "notice", content: "subagent finished", display: false },
			{ triggerTurn: true },
		);
		// No run may start while navigation is about to move the leaf.
		expect(session.isStreaming).toBe(false);
		await sent;
		expect(harness.getPendingResponseCount()).toBe(1);

		releaseSummary.resolve();
		expect((await navigating).cancelled).toBe(false);
		await session.waitForIdle();
		const branch = sessionManager.buildSessionContext().messages.map(describeMessage);
		expect(branch).toEqual([
			"user",
			"assistant:a1",
			"branchSummary",
			"custom:subagent finished",
			"assistant:reply to notice",
		]);
	}, 30_000);

	it("abort() cancels an in-flight branch summary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { session, sessionManager } = harness;
		harness.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
		await session.prompt("u1");
		await session.prompt("u2");
		const target = sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && getMessageText(entry.message) === "a1");

		const summaryStarted = deferred();
		harness.setResponses([responseUntilAborted(summaryStarted.resolve)]);
		const navigating = session.navigateTree(target!.id, { summarize: true });
		await summaryStarted.promise;

		expect(await settleWithin(session.abort(), 5_000)).toBe("resolved");
		expect(await navigating).toEqual({ cancelled: true, aborted: true });
		// Navigation did not commit: no summary entry, and the active branch is unchanged.
		expect(sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
		expect(sessionManager.buildSessionContext().messages.map(describeMessage)).toEqual([
			"user",
			"assistant:a1",
			"user",
			"assistant:a2",
		]);
		expect(session.isIdle).toBe(true);
	}, 30_000);

	it("rejects a prompt whose input handler was still running when manual compaction started", async () => {
		const inputEntered = deferred();
		const releaseInput = deferred();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "late prompt") return undefined;
						inputEntered.resolve();
						await releaseInput.promise;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		const { session } = harness;
		harness.setResponses([fauxAssistantMessage("seed answer ".repeat(200))]);
		await session.prompt("seed ".repeat(400));

		const summaryStarted = deferred();
		const releaseSummary = deferred();
		harness.setResponses([
			async () => {
				summaryStarted.resolve();
				await releaseSummary.promise;
				return fauxAssistantMessage("## Goal\nsummary");
			},
			fauxAssistantMessage("must not run during compaction"),
		]);
		const prompting = session.prompt("late prompt");
		await inputEntered.promise;
		const compacting = session.compact();
		await summaryStarted.promise;

		releaseInput.resolve();
		await expect(prompting).rejects.toThrow("compaction or branch summarization is in progress");
		expect(session.isStreaming).toBe(false);
		releaseSummary.resolve();
		await compacting;
		expect(harness.getPendingResponseCount()).toBe(1);
	}, 30_000);

	it("waitForIdle() waits for a prompt whose input handler has not finished", async () => {
		const inputEntered = deferred();
		const releaseInput = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputEntered.resolve();
						await releaseInput.promise;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		const { session } = harness;
		harness.setResponses([fauxAssistantMessage("answer")]);

		const prompting = session.prompt("question");
		await inputEntered.promise;
		// The prompt has not claimed its run yet, so the session still reports no active run.
		expect(session.isIdle).toBe(true);
		const waiting = session.waitForIdle();
		releaseInput.resolve();
		await waiting;

		expect(session.messages.map(describeMessage)).toEqual(["user", "assistant:answer"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		await prompting;
	}, 30_000);

	it("waitForIdle() from an input handler does not wait for that handler's own prompt", async () => {
		let waitedInHandler = false;
		const harness: Harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "wait") {
							// An extension holding a command context can reach waitForIdle() here.
							await harness.session.waitForIdle();
							waitedInHandler = true;
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);

		const outcome = await Promise.race([
			harness.session.prompt("wait").then(() => "settled"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
		]);

		expect(outcome).toBe("settled");
		expect(waitedInHandler).toBe(true);
		expect(harness.session.messages.map(describeMessage)).toEqual(["user", "assistant:answer"]);
	}, 30_000);
});
