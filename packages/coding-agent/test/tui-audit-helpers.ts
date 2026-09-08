import { type Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type HarnessOptions } from "./suite/harness.ts";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Real interactive owner and faux session, without terminal/process initialization. */
export async function createInteractiveHarness(options: HarnessOptions = {}) {
	initTheme("dark");
	const harness = await createHarness(options);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Unexpected session replacement in UI test");
		},
	);
	const keybindings = new KeybindingsManager();
	const keybindingsSpy = vi.spyOn(KeybindingsManager, "create").mockReturnValue(keybindings);
	let mode: InteractiveMode;
	try {
		mode = new InteractiveMode(runtime, { tuiMode: "regular" });
	} finally {
		keybindingsSpy.mockRestore();
	}
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	Reflect.set(mode, "renderer", tui);
	Reflect.set(mode, "isInitialized", true);
	Reflect.set(mode, "workingVisible", false);
	const editor = Reflect.get(mode, "defaultEditor") as CustomEditor;
	const editorContainer = Reflect.get(mode, "editorContainer") as Container;
	const chat = Reflect.get(mode, "chatContainer") as Container;
	const createContext = Reflect.get(mode, "createExtensionUIContext") as () => ExtensionUIContext;
	const context = createContext.call(mode);
	tui.addChild(chat);
	tui.addChild(editorContainer);
	tui.setFocus(editor);
	return {
		...harness,
		mode,
		tui,
		terminal,
		editor,
		editorContainer,
		chat,
		context,
		keybindings,
		cleanup() {
			tui.stop();
			harness.cleanup();
		},
	};
}
