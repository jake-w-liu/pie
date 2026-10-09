import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { PI_SESSION_SNAPSHOT_ARTIFACT } from "../src/vitest-evals/artifacts.ts";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
const unsubscribes: Array<() => void> = [];

function runContext(signal?: AbortSignal): HarnessContext {
	const artifacts: HarnessContext["artifacts"] = {};
	return {
		signal,
		artifacts,
		setArtifact: (name, value) => {
			artifacts[name] = value;
		},
	};
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-eval-compaction-regression-"));
	const home = join(root, "home");
	const temp = join(root, "temp");
	const agent = join(home, ".pi", "agent");
	await mkdir(temp, { recursive: true });
	await mkdir(agent, { recursive: true });
	for (const key of ["HOME", "USERPROFILE"]) vi.stubEnv(key, home);
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temp);
	for (const key of ["PI_CODING_AGENT_DIR", "PIE_CODING_AGENT_DIR"]) vi.stubEnv(key, agent);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network access");
		}),
	);
	faux = fauxProvider({ models: [{ id: "offline-trace", contextWindow: 100_000, maxTokens: 2000 }] });
	const create = ModelRuntime.create.bind(ModelRuntime);
	vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
		const runtime = await create(options);
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		return runtime;
	});
	const subscribe = AgentSession.prototype.subscribe;
	vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (this: AgentSession, listener) {
		const unsubscribe = vi.fn(subscribe.call(this, listener));
		unsubscribes.push(unsubscribe);
		return unsubscribe;
	});
});

afterEach(async () => {
	for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledOnce();
	unsubscribes.length = 0;
	expect(fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

describe("eval completion and complete trace across compaction", () => {
	it("uses actual completed assistants and retains earlier messages/tools across reload and real compaction", async () => {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "trace-fixture.txt" }, { id: "trace-read" })),
			...Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`answer-${index + 1}`)),
			fauxAssistantMessage("compacted checkpoint"),
			fauxAssistantMessage("compacted turn prefix"),
		]);
		// Keep compaction enabled. A small retained tail exercises real manual
		// compaction without requiring a network model or oversized test inputs.
		vi.spyOn(SettingsManager.prototype, "getCompactionSettings").mockReturnValue({
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 1,
		});
		let prompts = 0;
		let before = 0;
		let after = 0;
		const prompt = AgentSession.prototype.prompt;
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (
			this: AgentSession,
			...args: Parameters<AgentSession["prompt"]>
		) {
			if (prompts++ === 0)
				await writeFile(join(this.sessionManager.getCwd(), "trace-fixture.txt"), "retained tool payload");
			before = this.messages.length;
			await prompt.apply(this, args);
			if (prompts === 6) {
				await this.compact();
				after = this.messages.length;
			}
		});
		const harness = createPiCodingAgentHarness({
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
		});
		const input: PiCodingAgentInput = Array.from({ length: 5 }, (_, index) => ({
			type: "prompt",
			content: `request-${index + 1}`,
		}));
		input.push({ type: "reload" }, { type: "prompt", content: "request-6" });
		const context = runContext();
		const result = await harness.run(input, context);
		expect(before).toBeGreaterThanOrEqual(12);
		expect(after).toBeLessThan(before);
		expect(result.output).toBe("answer-6");
		expect(
			result.session.events.flatMap((event) =>
				event.type === "message" && event.role === "user" ? [event.content] : [],
			),
		).toEqual(Array.from({ length: 6 }, (_, index) => `request-${index + 1}`));
		expect(
			result.session.events.flatMap((event) =>
				event.type === "message" && event.role === "assistant" ? [event.content] : [],
			),
		).toEqual(Array.from({ length: 6 }, (_, index) => `answer-${index + 1}`));
		expect(result.session.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool_call",
					id: "trace-read",
					name: "read",
					arguments: { path: "trace-fixture.txt" },
				}),
				expect.objectContaining({
					type: "tool_result",
					toolCallId: "trace-read",
					name: "read",
					content: "retained tool payload",
				}),
			]),
		);
		expect(context.artifacts[PI_SESSION_SNAPSHOT_ARTIFACT]).toEqual(expect.stringContaining('"type":"compaction"'));
		expect(unsubscribes).toHaveLength(6);
	});

	it.each(["error", "aborted", "empty"] as const)(
		"does not accept an unsuccessful current assistant (%s)",
		async (kind) => {
			faux.setResponses([
				kind === "empty"
					? fauxAssistantMessage("")
					: fauxAssistantMessage("not success", {
							stopReason: kind,
							errorMessage: "offline assistant failed",
						}),
			]);
			const harness = createPiCodingAgentHarness({
				model: { provider: faux.getModel().provider, id: faux.getModel().id },
				noTools: "all",
			});
			await expect(harness.run("request", runContext())).rejects.toThrow(
				kind === "empty" ? "Agent run produced no assistant text" : "offline assistant failed",
			);
			expect(unsubscribes).toHaveLength(1);
		},
	);

	it("does not accept a stale assistant when the current prompt emits no completed message", async () => {
		vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
			this.agent.state.messages = [fauxAssistantMessage("stale answer")];
		});
		const harness = createPiCodingAgentHarness({
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
		});
		await expect(harness.run("request", runContext())).rejects.toThrow(
			"Agent run completed without an assistant message",
		);
		expect(unsubscribes).toHaveLength(1);
	});

	it("removes the subscription and preserves a thrown prompt failure", async () => {
		const failure = new Error("owned prompt failed");
		vi.spyOn(AgentSession.prototype, "prompt").mockRejectedValue(failure);
		const harness = createPiCodingAgentHarness({
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
		});
		await expect(harness.run("request", runContext())).rejects.toBe(failure);
		expect(unsubscribes).toHaveLength(1);
	});

	it("does not subscribe or create a model runtime after an already-aborted signal", async () => {
		const controller = new AbortController();
		const failure = new Error("cancelled before start");
		controller.abort(failure);
		const harness = createPiCodingAgentHarness({
			model: { provider: faux.getModel().provider, id: faux.getModel().id },
		});
		await expect(harness.run("request", runContext(controller.signal))).rejects.toBe(failure);
		expect(unsubscribes).toHaveLength(0);
		expect(ModelRuntime.create).not.toHaveBeenCalled();
	});
});
