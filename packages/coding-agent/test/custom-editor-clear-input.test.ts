import { CombinedAutocompleteProvider, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => setKeybindings(new KeybindingsManager()));

function createEditor(keybindings = new KeybindingsManager()): CustomEditor {
	setKeybindings(keybindings);
	return new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
}

describe("clear input without interruption", () => {
	it("clears every line on Escape without invoking interrupt or exit callbacks", () => {
		const editor = createEditor();
		const interrupt = vi.fn();
		const exit = vi.fn();
		editor.onEscape = interrupt;
		editor.onCtrlD = exit;
		editor.setText("first line\nsecond line\nlast line");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("");
		editor.handleInput("\x1b");
		expect(interrupt).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});

	it("preserves the separate interrupt binding", () => {
		const editor = createEditor();
		const interrupt = vi.fn();
		editor.onEscape = interrupt;
		editor.setText("draft");
		editor.handleInput("\x1b\x03"); // Ctrl+Alt+C in the legacy terminal protocol
		expect(interrupt).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("draft");
	});

	it("allows clear-input to be rebound or disabled", () => {
		const keybindings = new KeybindingsManager({ "app.editor.clear": "ctrl+k" });
		const editor = createEditor(keybindings);
		editor.setText("all\nlines");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("all\nlines");
		editor.handleInput("\x0b");
		expect(editor.getText()).toBe("");
		keybindings.setUserBindings({ "app.editor.clear": [] });
		editor.setText("keep");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("keep");
	});

	it("closes the completion menu before clearing the draft", async () => {
		const editor = createEditor();
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Select model" }], process.cwd()),
		);
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("/");
		editor.handleInput("\x1b");
		expect(editor.getText()).toBe("");
	});
});
