import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEventListener } from "../src/core/agent-session.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

async function expectSuccessfulPersistence(listener: AgentSessionEventListener) {
	const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("provider answer")]);
	harness.session.subscribe(listener);

	await expect(harness.session.prompt("hello")).resolves.toBeUndefined();
	await Promise.resolve();

	const persisted = harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
	expect(persisted).toHaveLength(2);
	expect(persisted[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	const assistant = persisted[1];
	if (assistant.role !== "assistant") throw new Error(`expected an assistant message, got ${assistant.role}`);
	expect(assistant.content).toEqual([{ type: "text", text: "provider answer" }]);
	expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
}

describe("AgentSession public listener isolation", () => {
	it("does not let a throwing observer replace a successful response", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expectSuccessfulPersistence((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") throw new Error("observer boom");
		});
		expect(error).toHaveBeenCalledWith("AgentSession event listener failed:", expect.any(Error));
	});

	it("handles a rejected observer promise without changing persistence", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expectSuccessfulPersistence(((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				return Promise.reject(new Error("async observer boom"));
			}
		}) as AgentSessionEventListener);
		expect(error).toHaveBeenCalledWith("AgentSession event listener failed:", expect.any(Error));
	});
});
