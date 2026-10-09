import { getEventListeners } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../../../src/core/exec.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

describe("extension command escalation", () => {
	it.each(["timeout", "abort"] as const)("forces an owned TERM-ignoring child to exit after %s", async (mode) => {
		const controller = new AbortController();
		let elapsed = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "exec_probe",
					label: "exec probe",
					description: "Executes an offline fixture",
					parameters: Type.Object({}),
					execute: async () => {
						const file = join(harness.tempDir, "ignore-term.mjs");
						writeFileSync(
							file,
							'process.on("SIGTERM", () => console.log("TERM ignored")); console.log("ready"); setTimeout(() => { console.log("natural exit"); process.exit(0); }, 8000);',
						);
						let timer: ReturnType<typeof setTimeout> | undefined;
						const started = performance.now();
						if (mode === "abort") timer = setTimeout(() => controller.abort(), 1000);
						try {
							const result = await execCommand(process.execPath, [file], harness.tempDir, {
								signal: controller.signal,
								timeout: mode === "timeout" ? 1000 : undefined,
							});
							elapsed = performance.now() - started;
							expect(result.killed).toBe(true);
							expect(result.stdout).toContain("TERM ignored");
							expect(result.stdout).not.toContain("natural exit");
							return { content: [{ type: "text", text: "command settled" }], details: result };
						} finally {
							clearTimeout(timer);
						}
					},
				},
			],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("exec_probe", {}, { id: "exec-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("complete"),
		]);
		await harness.session.prompt("Run the offline command");
		expect(elapsed).toBeGreaterThanOrEqual(5900);
		expect(elapsed).toBeLessThan(7500);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ isError: false, content: [{ type: "text", text: "command settled" }] },
		]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("clears the escalation timer when TERM succeeds and cleans up spawn failures", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new AbortController();
		const scheduled = vi.spyOn(globalThis, "setTimeout");
		const cleared = vi.spyOn(globalThis, "clearTimeout");
		const file = join(harness.tempDir, "handle-term.mjs");
		writeFileSync(
			file,
			'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); setTimeout(() => process.exit(0), 8000);',
		);
		const result = await execCommand(process.execPath, [file], harness.tempDir, {
			timeout: 1000,
			signal: controller.signal,
		});
		expect(result.killed).toBe(true);
		const escalation = scheduled.mock.calls.findIndex((call) => call[1] === 5000);
		expect(escalation).toBeGreaterThanOrEqual(0);
		expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[escalation].value);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		const missing = await execCommand(join(harness.tempDir, "missing-command"), [], harness.tempDir, {
			timeout: 1000,
			signal: controller.signal,
		});
		expect(missing.code).toBe(1);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
