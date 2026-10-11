import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import promptUrlWidgetExtension from "../src/extensions/prompt-url-widget/index.ts";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { DaxnutsComponent } from "../src/modes/interactive/components/daxnuts.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { matchSession, parseSearchQuery } from "../src/modes/interactive/components/session-selector-search.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
};
const model = (provider: string, id: string) =>
	({ provider, id, name: id, api: "openai-completions", contextWindow: 1000, maxTokens: 100 }) as never;
const session = (id: string, cwd = "/here") =>
	({
		path: `/tmp/${id}.jsonl`,
		id,
		cwd,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: id,
		allMessagesText: id,
	}) as never;

function treeRoots(): never {
	const timestamp = new Date().toISOString();
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "hello", timestamp: 0 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "x",
				provider: "x",
				model: "x",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
				stopReason: "stop",
				timestamp: 0,
			},
		},
	];
	const nodes = entries.map((entry) => ({ entry, children: [] as unknown[] }));
	nodes[0]!.children.push(nodes[1]);
	return nodes as never;
}

describe("interactive component audit regressions", () => {
	test("filtered scoped-model reorder preserves selection", () => {
		const models = [model("openai", "gpt-4o"), model("openai", "gpt-5"), model("openai", "gpt-5-mini")];
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: models, enabledModelIds: ["openai/gpt-4o", "openai/gpt-5", "openai/gpt-5-mini"] },
			{ onChange() {}, onPersist() {}, onCancel() {} },
		);
		for (const char of "gpt-5-mini") selector.handleInput(char);
		expect(() => selector.handleInput("\x1b[1;3A")).not.toThrow();
		expect((selector as any).filteredItems[(selector as any).selectedIndex].fullId).toBe("openai/gpt-5-mini");
	});

	test("session navigation during load keeps the first loaded row selected", async () => {
		const load = deferred<never[]>();
		let selected: string | undefined;
		const selector = new SessionSelectorComponent(
			() => load.promise,
			async () => [],
			(path) => {
				selected = path;
			},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		selector.getSessionList().handleInput("\x1b[B");
		load.resolve([session("first"), session("second")]);
		await flush();
		selector.getSessionList().handleInput("\r");
		expect(selected).toBe("/tmp/first.jsonl");
	});

	test("an inactive scope load is cached and no longer shown as loading", async () => {
		const all = deferred<never[]>();
		const selector = new SessionSelectorComponent(
			async () => [session("current")],
			() => all.promise,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await flush();
		selector.getSessionList().handleInput("\t");
		selector.getSessionList().handleInput("\t");
		all.resolve([session("other", "/elsewhere")]);
		await flush();
		selector.getSessionList().handleInput("\t");
		await flush();
		const output = selector.render(100).map(stripVTControlCharacters).join("\n");
		expect(output).toContain("other");
		expect(output).not.toContain("Loading ...");
	});

	test("navigation on an empty tree filter cannot leave a negative selection", () => {
		let selected: string | undefined;
		const selector = new TreeSelectorComponent(
			treeRoots(),
			"a1",
			24,
			(id) => {
				selected = id;
			},
			() => {},
			undefined,
			undefined,
			"labeled-only",
		);
		selector.handleInput("\x1b[A");
		selector.handleInput("\x1b[A");
		selector.handleInput("\x04");
		selector.handleInput("\r");
		expect(selected).toBe("u1");
	});

	test("catalog refresh preserves the highlighted model", async () => {
		const models = [model("anthropic", "claude-a"), model("openai", "gpt-b"), model("openai", "gpt-c")];
		const refresh = deferred<any>();
		let selected: any;
		const runtime = {
			getAvailableSnapshot: () => models,
			getModel: (provider: string, id: string) =>
				models.find((item: any) => item.provider === provider && item.id === id),
			getError: () => undefined,
			refresh: () => refresh.promise,
		};
		const selector = new ModelSelectorComponent(
			{ terminal: { rows: 40, columns: 100 }, requestRender() {} } as never,
			models[0],
			runtime as never,
			[],
			(value) => {
				selected = value;
			},
			() => {},
		);
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		refresh.resolve({ aborted: false, errors: new Map() });
		await flush();
		selector.handleInput("\r");
		expect(selected.id).toBe("gpt-c");
		selector.dispose();
	});

	test("stale prompt URL metadata completion is treated as cancellation", async () => {
		const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
		const lookup = deferred<any>();
		const exec = vi.fn(() => lookup.promise);
		const pi = {
			on: (name: string, handler: (...args: any[]) => unknown) => {
				const eventHandlers = handlers.get(name) ?? [];
				eventHandlers.push(handler);
				handlers.set(name, eventHandlers);
			},
			exec,
			getSessionName: () => undefined,
			setSessionName() {},
		};
		promptUrlWidgetExtension(pi as never);
		const runner = new ExtensionRunner(
			[{ path: "prompt-url-widget", handlers } as never],
			createExtensionRuntime(),
			"/tmp",
			SessionManager.inMemory("/tmp"),
			{} as never,
		);
		const setWidget = vi.fn();
		runner.setUIContext({ setWidget } as never, "tui");

		await runner.emitBeforeAgentStart(
			"You are given one or more GitHub PR URLs: https://github.com/o/r/pull/1",
			undefined,
			"",
			{ cwd: "/tmp" } as never,
		);
		expect(exec).toHaveBeenCalledOnce();
		expect(setWidget).toHaveBeenCalledOnce();

		runner.invalidate();
		lookup.resolve({ code: 0, stdout: JSON.stringify({ title: "Title", author: { login: "me" } }) });
		await flush();
		await flush();

		expect(setWidget).toHaveBeenCalledOnce();
	});

	test("wrapped bash preview has an expand notice and excluded header stays dim", () => {
		const component = new BashExecutionComponent("echo", { requestRender() {} } as never, true);
		const before = component.render(80)[2];
		component.appendOutput(Array.from({ length: 20 }, (_, index) => `${index}:${"x".repeat(220)}`).join("\n"));
		component.setComplete(0, false);
		const output = component.render(80);
		expect(output.map(stripVTControlCharacters).join("\n")).toContain("to expand");
		expect(output[2]?.match(/\x1b\[[\d;]+m/)?.[0]).toBe(before?.match(/\x1b\[[\d;]+m/)?.[0]);
	});

	test("narrow easter eggs and user-message rows respect width", () => {
		const tui = { requestRender() {} } as never;
		const dax = new DaxnutsComponent(tui);
		const armin = new ArminComponent(tui);
		const messages = new UserMessageSelectorComponent(
			[{ id: "1", text: "hello" }],
			() => {},
			() => {},
		);
		for (const width of [5, 10, 20]) {
			for (const line of [
				...dax.render(width),
				...armin.render(width),
				...messages.getMessageList().render(width),
			]) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		dax.dispose();
		armin.dispose();
	});

	test("pathological intra-line diff falls back within the timeout and retains text", () => {
		const oldText = Array.from({ length: 2500 }, (_, index) => `old${index}`).join(" ");
		const newText = Array.from({ length: 2500 }, (_, index) => `new${index}`).join(" ");
		const started = performance.now();
		const output = stripVTControlCharacters(renderDiff(`-1 ${oldText}\n+1 ${newText}`));
		expect(performance.now() - started).toBeLessThan(1000);
		expect(output).toContain(oldText);
		expect(output).toContain(newText);
	});

	test("quoted phrase normalization is cached per session object", () => {
		let reads = 0;
		const value = {
			...(session("cached") as unknown as Record<string, unknown>),
			get allMessagesText() {
				reads++;
				return "A   repeated phrase";
			},
		};
		const query = parseSearchQuery('"repeated phrase"');
		expect(matchSession(value as never, query).matches).toBe(true);
		expect(matchSession(value as never, query).matches).toBe(true);
		expect(reads).toBe(1);
	});
});
