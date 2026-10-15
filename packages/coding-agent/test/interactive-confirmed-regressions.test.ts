import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createInteractiveHarness, deferred } from "./tui-audit-helpers.ts";

function callPrivate(instance: object, name: string, ...args: unknown[]): unknown {
	const method = Reflect.get(instance, name) as (...methodArgs: unknown[]) => unknown;
	return method.call(instance, ...args);
}

describe("interactive confirmed regressions", () => {
	it("aborts a prompt interrupted during before_agent_start", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const harness = await createInteractiveHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered.resolve();
						await release.promise;
						return undefined;
					});
				},
			],
		});
		try {
			await callPrivate(harness.mode, "bindCurrentSessionExtensions");
			callPrivate(harness.mode, "setupKeyHandlers");
			harness.setResponses([fauxAssistantMessage("model was called")]);

			const prompt = harness.session.prompt("hello");
			await entered.promise;
			harness.editor.onEscape?.();
			release.resolve();

			await expect(prompt).rejects.toThrow("Prompt cancelled");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(false);
		} finally {
			harness.cleanup();
		}
	}, 30_000);

	it("shuts down at once when an extension shortcut requests shutdown while idle", async () => {
		const harness = await createInteractiveHarness({
			extensionFactories: [
				(pi) => {
					pi.registerShortcut("alt+y", {
						description: "Quit",
						handler: (ctx) => {
							ctx.shutdown();
						},
					});
				},
			],
		});
		try {
			const shutdown = vi.fn(async () => {});
			Reflect.set(harness.mode, "shutdown", shutdown);
			await callPrivate(harness.mode, "bindCurrentSessionExtensions");
			expect(harness.session.isIdle).toBe(true);

			expect(harness.editor.onExtensionShortcut?.("\x1by")).toBe(true);

			expect(shutdown).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
		}
	}, 30_000);

	it("renders one error for a failed manual compaction", async () => {
		const harness = await createInteractiveHarness();
		try {
			callPrivate(harness.mode, "subscribeToAgent");
			await callPrivate(harness.mode, "handleCompactCommand");

			const transcript = harness.chat.render(120).map(stripAnsi).join("\n");
			expect(transcript.match(/Error:/g)).toHaveLength(1);
			expect(transcript).toContain("Compaction failed: Nothing to compact");
		} finally {
			harness.cleanup();
		}
	}, 30_000);

	it.each([
		{
			kind: "select",
			open: (harness: Awaited<ReturnType<typeof createInteractiveHarness>>, title: string) =>
				harness.context.select(title, ["chosen"]),
			submit: (harness: Awaited<ReturnType<typeof createInteractiveHarness>>) =>
				harness.tui.getFocusedComponent()?.handleInput?.("\r"),
			expected: "chosen",
		},
		{
			kind: "input",
			open: (harness: Awaited<ReturnType<typeof createInteractiveHarness>>, title: string) =>
				harness.context.input(title),
			submit: (harness: Awaited<ReturnType<typeof createInteractiveHarness>>) => {
				harness.tui.getFocusedComponent()?.handleInput?.("value");
				harness.tui.getFocusedComponent()?.handleInput?.("\r");
			},
			expected: "value",
		},
		{
			kind: "editor",
			open: (harness: Awaited<ReturnType<typeof createInteractiveHarness>>, title: string) =>
				harness.context.editor(title, "value"),
			submit: (harness: Awaited<ReturnType<typeof createInteractiveHarness>>) =>
				harness.tui.getFocusedComponent()?.handleInput?.("\r"),
			expected: "value",
		},
	])(
		"settles reset and superseded $kind dialogs",
		async ({ open, submit, expected }) => {
			const harness = await createInteractiveHarness();
			try {
				const resetDialog = open(harness, "reset");
				callPrivate(harness.mode, "resetExtensionUI");
				await expect(resetDialog).resolves.toBeUndefined();

				const superseded = open(harness, "first");
				const active = open(harness, "second");
				await expect(superseded).resolves.toBeUndefined();
				submit(harness);
				await expect(active).resolves.toBe(expected);
			} finally {
				harness.cleanup();
			}
		},
		30_000,
	);
});
