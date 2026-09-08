import { type Editor, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import type { ExternalEditorResult } from "../src/modes/interactive/external-editor.ts";
import { createInteractiveHarness, deferred } from "./tui-audit-helpers.ts";

const mocks = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock("../src/modes/interactive/external-editor.ts", () => ({ editInExternalEditor: mocks.edit }));

describe("extension external editor paste transfer", () => {
	afterEach(() => {
		mocks.edit.mockReset();
		setKeybindings(new KeybindingsManager());
	});
	it.each(["complete", "failed"] as const)(
		"exports expanded input and handles %s with the configured binding",
		async (status) => {
			const harness = await createInteractiveHarness();
			try {
				const keys = new KeybindingsManager({ "app.editor.external": ["ctrl+x"] });
				setKeybindings(keys);
				const gate = deferred<ExternalEditorResult>();
				mocks.edit.mockReturnValue(gate.promise);
				const start = vi.spyOn(harness.tui, "start");
				const stop = vi.spyOn(harness.tui, "stop");
				const submit = vi.fn();
				const cancel = vi.fn();
				const component = new ExtensionEditorComponent(
					harness.tui,
					keys,
					"Test",
					undefined,
					submit,
					cancel,
					undefined,
					"fake-editor",
				);
				const original = "a large paste 字\n".repeat(200);
				component.handleInput(`\x1b[200~${original}\x1b[201~`);
				const editor = Reflect.get(component, "editor") as Editor;
				expect(editor.getText()).not.toBe(original);
				const raw = editor.getText();
				component.handleInput("\x18");
				expect(mocks.edit).toHaveBeenCalledExactlyOnceWith({ command: "fake-editor", content: original });
				expect(stop).toHaveBeenCalledTimes(1);
				gate.resolve(status === "complete" ? { status, content: `${original}edited` } : { status });
				await Promise.resolve();
				expect(start).toHaveBeenCalledTimes(1);
				if (status === "failed") expect(editor.getText()).toBe(raw);
				component.handleInput("\r");
				expect(submit).toHaveBeenCalledExactlyOnceWith(
					status === "complete" ? `${original}edited` : original.trim(),
				);
				expect(cancel).not.toHaveBeenCalled();
			} finally {
				harness.cleanup();
			}
		},
	);
});
