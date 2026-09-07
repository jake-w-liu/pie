import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AutocompleteSuggestions, CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const commands = [{ name: "model" }, { name: "skill:deep-debug" }, { name: "skill:review" }];

async function flushAutocomplete(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("slash completion lifecycle", () => {
	for (const prefix of ["/skill:deep-debug ", "/skill:deep-debug please ", "please /skill:deep-debug "]) {
		for (const paced of [false, true]) {
			it(`completes a second slash after ${JSON.stringify(prefix)} (${paced ? "paced" : "batched"})`, async (t) => {
				const tui = new TuiMainScreen(new VirtualTerminal());
				t.after(() => tui.stop());
				const editor = new Editor(tui, defaultEditorTheme);
				editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
				let submitted: string | undefined;
				editor.onSubmit = (text) => {
					submitted = text;
				};
				for (const character of `${prefix}/mo`) {
					editor.handleInput(character);
					if (paced) await flushAutocomplete();
				}
				await flushAutocomplete();
				assert.equal(editor.isShowingAutocomplete(), true);
				editor.handleInput("\r");
				assert.equal(editor.getText(), `${prefix}/model `);
				assert.equal(submitted, undefined);
				editor.handleInput("/");
				await flushAutocomplete();
				assert.equal(editor.isShowingAutocomplete(), true, "third slash must reopen the menu");
			});
		}
	}

	it("keeps a leading command's argument completer in charge of absolute paths", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				...commands,
				{ name: "export", getArgumentCompletions: (prefix) => [{ value: `${prefix}.html`, label: "output" }] },
			],
			process.cwd(),
		);
		const line = "/export /mo";
		const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.deepEqual(result, { prefix: "/mo", items: [{ value: "/mo.html", label: "output" }] });
	});

	for (const line of ["/skill:deep-debug ", "/skill:deep-debug /model "]) {
		it(`closes suggestions after ${JSON.stringify(line)}`, async () => {
			const provider = new CombinedAutocompleteProvider(commands, process.cwd());
			assert.equal(
				await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal }),
				null,
			);
		});
	}

	for (const key of ["\t", "\r"]) {
		it(`does not accept stale suggestions with ${JSON.stringify(key)} during a refresh`, async (t) => {
			const tui = new TuiMainScreen(new VirtualTerminal());
			t.after(() => tui.stop());
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
			editor.setText("please /m");
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.equal(editor.isShowingAutocomplete(), true);
			editor.handleInput("o");
			editor.handleInput(key);
			assert.equal(editor.getText(), "please /mo", "old prefix must not overwrite newly typed text");
			await flushAutocomplete();
			editor.handleInput(key);
			assert.equal(editor.getText(), "please /model ");
		});
	}

	it("keeps provider query snapshots isolated from later editor changes", async (t) => {
		const tui = new TuiMainScreen(new VirtualTerminal());
		t.after(() => tui.stop());
		const editor = new Editor(tui, defaultEditorTheme);
		const queries: string[][] = [];
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, row, col, options) => {
				queries.push(lines);
				return provider.getSuggestions(lines, row, col, options);
			},
			applyCompletion: (...args) => provider.applyCompletion(...args),
		});
		editor.handleInput("/");
		await flushAutocomplete();
		editor.handleInput("m");
		await flushAutocomplete();
		assert.deepEqual(queries, [["/"], ["/m"]]);
		queries[0]![0] = "mutated by an old provider";
		assert.equal(editor.getText(), "/m");
		assert.deepEqual(queries[1], ["/m"]);
	});

	for (const finishWithError of [false, true]) {
		it(`starts a fresh request without waiting for a cancelled provider (${finishWithError ? "reject" : "resolve"})`, async (t) => {
			const tui = new TuiMainScreen(new VirtualTerminal());
			t.after(() => tui.stop());
			const editor = new Editor(tui, defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(commands, process.cwd());
			let resolveOld!: (value: AutocompleteSuggestions | null) => void;
			let rejectOld!: (error: Error) => void;
			const oldResult = new Promise<AutocompleteSuggestions | null>((resolve, reject) => {
				resolveOld = resolve;
				rejectOld = reject;
			});
			t.after(() => resolveOld(null));
			let calls = 0;
			let oldSignal: AbortSignal | undefined;
			editor.setAutocompleteProvider({
				getSuggestions: async (lines, row, col, options) => {
					calls++;
					if (calls === 1) {
						oldSignal = options.signal;
						return oldResult;
					}
					return provider.getSuggestions(lines, row, col, options);
				},
				applyCompletion: (...args) => provider.applyCompletion(...args),
			});
			editor.handleInput("/");
			await flushAutocomplete();
			editor.setText("");
			editor.handleInput("/");
			await flushAutocomplete();
			assert.equal(oldSignal?.aborted, true);
			assert.equal(calls, 2);
			assert.equal(editor.isShowingAutocomplete(), true);
			if (finishWithError) rejectOld(new Error("late provider failure"));
			else resolveOld({ prefix: "/", items: [{ value: "stale", label: "stale" }] });
			await flushAutocomplete();
			editor.handleInput("\t");
			assert.equal(editor.getText(), "/model ", "late results must not replace current suggestions");
		});
	}
});
