import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

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
});
