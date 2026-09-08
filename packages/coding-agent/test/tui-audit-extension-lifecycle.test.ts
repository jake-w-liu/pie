import { type Component, Editor, type EditorComponent, type OverlayHandle } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInteractiveHarness, deferred } from "./tui-audit-helpers.ts";

function panel(label: string) {
	return { render: () => [label], invalidate() {}, handleInput: vi.fn(), dispose: vi.fn(), focused: false };
}

async function settlement<T>(promise: Promise<T>) {
	return Promise.race([
		promise.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		),
		new Promise<{ status: "pending" }>((resolve) => setImmediate(() => resolve({ status: "pending" }))),
	]);
}

const paste = "original large paste 字\n".repeat(200);

describe("extension custom UI ownership and editor state", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
	async function setup() {
		const harness = await createInteractiveHarness();
		cleanups.push(harness.cleanup);
		return harness;
	}

	it("closes only its own lower overlay, retaining the top overlay and focus", async () => {
		const { context, tui } = await setup();
		const lower = panel("lower");
		const upper = panel("upper");
		let done!: (result: string) => void;
		const result = context.custom<string>(
			(_tui, _theme, _keys, close) => {
				done = close;
				return lower;
			},
			{ overlay: true },
		);
		await Promise.resolve();
		const upperHandle = tui.showOverlay(upper);
		done("finished");
		expect(await result).toBe("finished");
		expect(upperHandle.isFocused()).toBe(true);
		done("ignored");
		expect(lower.dispose).toHaveBeenCalledTimes(1);
		upperHandle.hide();
		expect(tui.hasOverlay()).toBe(false);
	});

	it.each([false, true])(
		"synchronous done before mount cannot touch existing UI (async factory: %s)",
		async (asyncFactory) => {
			const { context, tui } = await setup();
			const existing = tui.showOverlay(panel("existing"));
			const unused = panel("unused");
			const gate = deferred<typeof unused>();
			const result = context.custom<string>(
				(_tui, _theme, _keys, done) => {
					done("early");
					return asyncFactory ? gate.promise : unused;
				},
				{ overlay: true },
			);
			expect(await result).toBe("early");
			expect(existing.isFocused()).toBe(true);
			gate.resolve(unused);
			await Promise.resolve();
			expect(unused.dispose).toHaveBeenCalledTimes(1);
			existing.hide();
			expect(tui.hasOverlay()).toBe(false);
		},
	);

	it("disposes a component arriving after external completion exactly once", async () => {
		const { context, editorContainer, editor } = await setup();
		const late = panel("late");
		const gate = deferred<typeof late>();
		let done!: (result: number) => void;
		const result = context.custom<number>((_tui, _theme, _keys, close) => {
			done = close;
			return gate.promise;
		});
		done(1);
		expect(await result).toBe(1);
		gate.resolve(late);
		await Promise.resolve();
		done(2);
		expect(late.dispose).toHaveBeenCalledTimes(1);
		expect(editorContainer.children).toEqual([editor]);
	});

	it("cleans up onHandle failure and ignores done after rejection", async () => {
		const { context, tui } = await setup();
		const existing = tui.showOverlay(panel("existing"));
		const failed = panel("failed");
		let done!: () => void;
		const result = context.custom<void>(
			(_tui, _theme, _keys, close) => {
				done = close;
				return failed;
			},
			{
				overlay: true,
				onHandle() {
					throw new Error("mount failed");
				},
			},
		);
		await expect(result).rejects.toThrow("mount failed");
		expect(existing.isFocused()).toBe(true);
		expect(failed.dispose).toHaveBeenCalledTimes(1);
		done();
		expect(existing.isFocused()).toBe(true);
		existing.hide();
		expect(tui.hasOverlay()).toBe(false);
	});

	it.each(["sync", "async", "options"])(
		"settles %s factory/options failures without disturbing other UI",
		async (failure) => {
			const { context, tui } = await setup();
			const existing = tui.showOverlay(panel("existing"));
			const failed = panel("failed");
			let done!: () => void;
			const result = context.custom<void>(
				(_tui, _theme, _keys, close) => {
					done = close;
					if (failure === "sync") throw new Error("expected failure");
					if (failure === "async") return Promise.reject(new Error("expected failure"));
					return failed;
				},
				{
					overlay: true,
					overlayOptions() {
						throw new Error("expected failure");
					},
				},
			);
			await expect(result).rejects.toThrow("expected failure");
			done();
			expect(existing.isFocused()).toBe(true);
			expect(failed.dispose).toHaveBeenCalledTimes(failure === "options" ? 1 : 0);
			existing.hide();
		},
	);

	it.each(["options", "focus"])(
		"does not leave a mounted overlay after reentrant completion during %s",
		async (during) => {
			const { context, tui } = await setup();
			const existing = tui.showOverlay(panel("existing"));
			const component = panel("early-close");
			let done!: () => void;
			if (during === "focus")
				Object.defineProperty(component, "focused", {
					get: () => false,
					set: (value: boolean) => {
						if (value) done();
					},
				});
			const result = context.custom<void>(
				(_tui, _theme, _keys, close) => {
					done = close;
					return component;
				},
				{
					overlay: true,
					overlayOptions() {
						if (during === "options") done();
						return {};
					},
				},
			);
			await result;
			expect(existing.isFocused()).toBe(true);
			expect(component.dispose).toHaveBeenCalledTimes(1);
			existing.hide();
			expect(tui.hasOverlay()).toBe(false);
		},
	);

	it("allows reentrant completion from onHandle and disposal failures without double cleanup", async () => {
		const { context, tui } = await setup();
		const component = panel("panel");
		component.dispose.mockImplementation(() => {
			throw new Error("dispose failure");
		});
		let done!: (result: number) => void;
		const result = context.custom<number>(
			(_tui, _theme, _keys, close) => {
				done = close;
				return component;
			},
			{
				overlay: true,
				onHandle(handle: OverlayHandle) {
					expect(handle.isFocused()).toBe(true);
					done(42);
				},
			},
		);
		expect(await result).toBe(42);
		done(43);
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(tui.hasOverlay()).toBe(false);
	});

	it.each(["onHandle", "focus", "inline"])(
		"rejects %s completion when real focus cleanup throws, without retaining disposed UI",
		async (during) => {
			const { context, tui, editor, editorContainer } = await setup();
			const component = panel("throwing blur");
			const error = new Error("focus cleanup failed");
			let done!: () => void;
			Object.defineProperty(component, "focused", {
				get: () => false,
				set(value: boolean) {
					if (!value) throw error;
					if (during !== "onHandle") done();
				},
			});
			const result = context.custom<void>(
				(_tui, _theme, _keys, close) => {
					done = close;
					return component;
				},
				{ overlay: during !== "inline", onHandle: () => done() },
			);
			expect(await settlement(result)).toEqual({ status: "rejected", error });
			expect(component.dispose).toHaveBeenCalledTimes(1);
			expect(tui.hasOverlay()).toBe(false);
			expect(tui.getFocusedComponent()).toBe(editor);
			expect(editorContainer.children).toEqual([editor]);
			expect(() => done()).not.toThrow();
			expect(component.dispose).toHaveBeenCalledTimes(1);
		},
	);

	it.each([false, true])("rolls back failed focus acquisition (overlay: %s)", async (overlay) => {
		const { context, tui, editor, editorContainer } = await setup();
		const component = panel("throwing focus");
		const error = new Error("focus acquisition failed");
		Object.defineProperty(component, "focused", {
			get: () => false,
			set(value: boolean) {
				if (value) throw error;
			},
		});
		expect(await settlement(context.custom(() => component, { overlay }))).toEqual({ status: "rejected", error });
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(tui.hasOverlay()).toBe(false);
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editorContainer.children).toEqual([editor]);
	});

	it("rolls back only the failed acquisition while retaining reentrant overlay ownership", async () => {
		const { context, tui, editor } = await setup();
		const component = panel("failed acquisition");
		const upper = panel("reentrant upper");
		const error = new Error("focus acquisition failed");
		let upperHandle!: OverlayHandle;
		Object.defineProperty(component, "focused", {
			get: () => false,
			set(value: boolean) {
				if (!value) return;
				upperHandle = tui.showOverlay(upper);
				throw error;
			},
		});
		expect(await settlement(context.custom(() => component, { overlay: true }))).toEqual({
			status: "rejected",
			error,
		});
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(upperHandle.isFocused()).toBe(true);
		expect(upper.dispose).not.toHaveBeenCalled();
		upperHandle.hide();
		expect(tui.hasOverlay()).toBe(false);
		expect(tui.getFocusedComponent()).toBe(editor);
	});

	it.each([false, true])("retains newer reentrant focus during cleanup (blur throws: %s)", async (throws) => {
		const { context, tui, editor } = await setup();
		const component = panel("closing overlay");
		const upper = panel("reentrant upper");
		const error = new Error("focus cleanup failed");
		let upperHandle: OverlayHandle | undefined;
		let creatingUpper = false;
		let done!: (value: number) => void;
		Object.defineProperty(component, "focused", {
			get: () => false,
			set(value: boolean) {
				if (value || creatingUpper) return;
				creatingUpper = true;
				upperHandle = tui.showOverlay(upper);
				if (throws) throw error;
			},
		});
		const result = context.custom<number>(
			(_tui, _theme, _keys, close) => {
				done = close;
				return component;
			},
			{ overlay: true, onHandle: () => done(42) },
		);
		expect(await settlement(result)).toEqual(
			throws ? { status: "rejected", error } : { status: "fulfilled", value: 42 },
		);
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(upperHandle?.isFocused()).toBe(true);
		expect(upper.dispose).not.toHaveBeenCalled();
		upperHandle?.hide();
		expect(tui.hasOverlay()).toBe(false);
		expect(tui.getFocusedComponent()).toBe(editor);
	});

	it.each([false, true])(
		"retains a reentrant overlay when inline mounting completes (mount throws: %s)",
		async (throws) => {
			const { context, tui, terminal, editor, editorContainer } = await setup();
			const component = panel("inline owner");
			const upper = panel("reentrant upper");
			const mountError = new Error("inline mount failed");
			const editorInput = vi.spyOn(editor, "handleInput");
			let upperHandle!: OverlayHandle;
			let createdUpper = false;
			let done!: (value: number) => void;
			Object.defineProperty(component, "focused", {
				get: () => false,
				set(value: boolean) {
					if (!value || createdUpper) return;
					createdUpper = true;
					upperHandle = tui.showOverlay(upper);
					done(42);
					if (throws) throw mountError;
				},
			});
			tui.start();
			const result = context.custom<number>((_tui, _theme, _keys, close) => {
				done = close;
				return component;
			});
			expect(await settlement(result)).toEqual(
				throws ? { status: "rejected", error: mountError } : { status: "fulfilled", value: 42 },
			);
			expect(component.dispose).toHaveBeenCalledTimes(1);
			expect(editorContainer.children).toEqual([editor]);
			expect(upperHandle.isFocused()).toBe(true);
			terminal.sendInput("u");
			expect(upper.handleInput).toHaveBeenCalledExactlyOnceWith("u");
			expect(editorInput).not.toHaveBeenCalled();
			expect(component.handleInput).not.toHaveBeenCalled();
			upperHandle.hide();
			await new Promise<void>((resolve) => setImmediate(resolve));
			terminal.sendInput("e");
			expect(tui.getFocusedComponent()).toBe(editor);
			expect(editorInput).toHaveBeenCalledExactlyOnceWith("e");
			expect(component.handleInput).not.toHaveBeenCalled();
			expect(component.dispose).toHaveBeenCalledTimes(1);
			expect(upper.dispose).not.toHaveBeenCalled();
			expect(tui.hasOverlay()).toBe(false);
		},
	);

	it("retires inline fallback references in a non-capturing overlay before it later takes focus", async () => {
		const { context, tui, terminal, editor } = await setup();
		const component = panel("inline owner");
		const upper = panel("passive upper");
		const editorInput = vi.spyOn(editor, "handleInput");
		let upperHandle!: OverlayHandle;
		let createdUpper = false;
		let done!: () => void;
		Object.defineProperty(component, "focused", {
			get: () => false,
			set(value: boolean) {
				if (!value || createdUpper) return;
				createdUpper = true;
				upperHandle = tui.showOverlay(upper, { nonCapturing: true });
				done();
			},
		});
		tui.start();
		const result = context.custom<void>((_tui, _theme, _keys, close) => {
			done = close;
			return component;
		});
		expect(await settlement(result)).toEqual({ status: "fulfilled", value: undefined });
		expect(tui.getFocusedComponent()).toBe(editor);
		upperHandle.focus();
		terminal.sendInput("u");
		expect(upper.handleInput).toHaveBeenCalledExactlyOnceWith("u");
		upperHandle.hide();
		await new Promise<void>((resolve) => setImmediate(resolve));
		terminal.sendInput("e");
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editorInput).toHaveBeenCalledExactlyOnceWith("e");
		expect(component.handleInput).not.toHaveBeenCalled();
		expect(component.dispose).toHaveBeenCalledTimes(1);
	});

	it("retires an explicit pending resume target when another invocation removes that overlay", async () => {
		const { context, tui, terminal, editor } = await setup();
		const component = panel("departing overlay");
		const upper = panel("upper overlay");
		const blocker = panel("inline blocker");
		const editorInput = vi.spyOn(editor, "handleInput");
		let doneComponent!: () => void;
		let doneBlocker!: () => void;
		tui.start();
		const componentResult = context.custom<void>(
			(_tui, _theme, _keys, close) => {
				doneComponent = close;
				return component;
			},
			{ overlay: true },
		);
		await Promise.resolve();
		const upperHandle = tui.showOverlay(upper);
		const blockerResult = context.custom<void>((_tui, _theme, _keys, close) => {
			doneBlocker = close;
			return blocker;
		});
		await Promise.resolve();
		upperHandle.unfocus({ target: component });
		doneComponent();
		expect(await settlement(componentResult)).toEqual({ status: "fulfilled", value: undefined });
		expect(component.dispose).toHaveBeenCalledTimes(1);
		terminal.sendInput("b");
		expect(blocker.handleInput).toHaveBeenCalledExactlyOnceWith("b");
		doneBlocker();
		expect(await settlement(blockerResult)).toEqual({ status: "fulfilled", value: undefined });
		expect(tui.getFocusedComponent()).toBe(editor);
		await new Promise<void>((resolve) => setImmediate(resolve));
		terminal.sendInput("e");
		expect(editorInput).toHaveBeenCalledExactlyOnceWith("e");
		expect(component.handleInput).not.toHaveBeenCalled();
		expect(upper.handleInput).not.toHaveBeenCalled();
		upperHandle.hide();
		terminal.sendInput("f");
		expect(editorInput.mock.calls).toEqual([["e"], ["f"]]);
		expect(component.handleInput).not.toHaveBeenCalled();
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(blocker.dispose).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("retires a displaced inline owner's references (explicit resume: %s)", async (explicit) => {
		const { context, tui, terminal, editor, editorContainer } = await setup();
		const component = panel("displaced inline owner");
		const upper = panel("upper overlay");
		const blocker = panel("replacement inline owner");
		const editorInput = vi.spyOn(editor, "handleInput");
		let doneComponent!: () => void;
		let doneBlocker!: () => void;
		tui.start();
		const componentResult = context.custom<void>((_tui, _theme, _keys, close) => {
			doneComponent = close;
			return component;
		});
		await Promise.resolve();
		const upperHandle = tui.showOverlay(upper);
		const blockerResult = context.custom<void>((_tui, _theme, _keys, close) => {
			doneBlocker = close;
			return blocker;
		});
		await Promise.resolve();
		if (explicit) upperHandle.unfocus({ target: component });
		doneComponent();
		expect(await settlement(componentResult)).toEqual({ status: "fulfilled", value: undefined });
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(editorContainer.children).toEqual([blocker]);
		expect(tui.getFocusedComponent()).toBe(blocker);
		terminal.sendInput("b");
		expect(blocker.handleInput).toHaveBeenCalledExactlyOnceWith("b");
		doneBlocker();
		expect(await settlement(blockerResult)).toEqual({ status: "fulfilled", value: undefined });
		expect(editorContainer.children).toEqual([editor]);
		if (explicit) {
			expect(tui.getFocusedComponent()).toBe(editor);
			expect(upperHandle.isFocused()).toBe(false);
		} else {
			expect(upperHandle.isFocused()).toBe(true);
			terminal.sendInput("u");
			expect(upper.handleInput).toHaveBeenCalledExactlyOnceWith("u");
		}
		upperHandle.hide();
		await new Promise<void>((resolve) => setImmediate(resolve));
		terminal.sendInput("e");
		expect(tui.getFocusedComponent()).toBe(editor);
		expect(editorInput).toHaveBeenCalledExactlyOnceWith("e");
		expect(component.handleInput).not.toHaveBeenCalled();
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(blocker.dispose).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"ignores permanently removed handles after custom settlement (onHandle throws: %s)",
		async (throws) => {
			const { context, tui, terminal, editor } = await setup();
			const component = panel("retired owner");
			const upper = panel("new upper");
			const mountError = new Error("onHandle failed after exposure");
			const editorInput = vi.spyOn(editor, "handleInput");
			let retired!: OverlayHandle;
			let done!: () => void;
			tui.start();
			const result = context.custom<void>(
				(_tui, _theme, _keys, close) => {
					done = close;
					return component;
				},
				{
					overlay: true,
					onHandle(handle) {
						retired = handle;
						if (throws) throw mountError;
						done();
					},
				},
			);
			expect(await settlement(result)).toEqual(
				throws ? { status: "rejected", error: mountError } : { status: "fulfilled", value: undefined },
			);
			expect(component.dispose).toHaveBeenCalledTimes(1);
			retired.setHidden(true);
			retired.setHidden(false);
			terminal.sendInput("e");
			expect(tui.getFocusedComponent()).toBe(editor);
			expect(editorInput).toHaveBeenCalledExactlyOnceWith("e");
			expect(component.handleInput).not.toHaveBeenCalled();
			expect(tui.hasOverlay()).toBe(false);
			const upperHandle = tui.showOverlay(upper);
			retired.setHidden(true);
			retired.setHidden(false);
			retired.focus();
			retired.unfocus({ target: component });
			terminal.sendInput("u");
			expect(upperHandle.isFocused()).toBe(true);
			expect(upper.handleInput).toHaveBeenCalledExactlyOnceWith("u");
			upperHandle.hide();
			await new Promise<void>((resolve) => setImmediate(resolve));
			terminal.sendInput("f");
			expect(editorInput.mock.calls).toEqual([["e"], ["f"]]);
			expect(component.handleInput).not.toHaveBeenCalled();
			expect(component.dispose).toHaveBeenCalledTimes(1);
		},
	);

	it("reports both mount and focus-cleanup failures while completing owned disposal", async () => {
		const { context, tui, editor } = await setup();
		const component = panel("double failure");
		const mountError = new Error("onHandle failed");
		const cleanupError = new Error("focus cleanup failed");
		Object.defineProperty(component, "focused", {
			get: () => false,
			set(value: boolean) {
				if (!value) throw cleanupError;
			},
		});
		const outcome = await settlement(
			context.custom(() => component, {
				overlay: true,
				onHandle() {
					throw mountError;
				},
			}),
		);
		expect(outcome.status).toBe("rejected");
		if (outcome.status !== "rejected") throw new Error("Custom UI did not reject");
		expect(outcome.error).toBeInstanceOf(AggregateError);
		expect((outcome.error as AggregateError).errors).toEqual([mountError, cleanupError]);
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(tui.hasOverlay()).toBe(false);
		expect(tui.getFocusedComponent()).toBe(editor);
	});

	it("remounts the same editor without serializing paste markers, cursor, or undo state", async () => {
		const { context, editor, editorContainer } = await setup();
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		editor.handleInput("\x1b[D");
		const text = editor.getText();
		const cursor = editor.getCursor();
		let done!: () => void;
		const result = context.custom<void>((_tui, _theme, _keys, close) => {
			done = close;
			return panel("dialog");
		});
		await Promise.resolve();
		done();
		await result;
		expect(editorContainer.children).toEqual([editor]);
		expect(editor.getText()).toBe(text);
		expect(editor.getCursor()).toEqual(cursor);
		expect(context.getEditorText()).toBe(paste);
		context.setEditorComponent(undefined);
		expect(editor.getCursor()).toEqual(cursor);
		expect(context.getEditorText()).toBe(paste);
		editor.handleInput("\x1f");
		expect(editor.getExpandedText()).toBe("");
	});

	it("transfers expanded text both ways, but preserves same-instance editors", async () => {
		const { context, editor } = await setup();
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		let custom!: Editor;
		context.setEditorComponent((tui, theme) => {
			custom = new Editor(tui, theme);
			return custom;
		});
		expect(custom.getExpandedText()).toBe(paste);
		custom.setText("");
		custom.handleInput(`\x1b[200~${paste}custom\x1b[201~`);
		custom.handleInput("\x1b[D");
		const cursor = custom.getCursor();
		context.setEditorComponent(() => custom);
		expect(custom.getCursor()).toEqual(cursor);
		expect(custom.getExpandedText()).toBe(`${paste}custom`);
		context.setEditorComponent(undefined);
		expect(editor.getExpandedText()).toBe(`${paste}custom`);
	});

	it("falls back to getText for a custom editor without getExpandedText", async () => {
		const { context, editor } = await setup();
		let text = "";
		const custom: EditorComponent & Component = {
			render: () => [text],
			invalidate() {},
			handleInput() {},
			getText: () => text,
			setText(value) {
				text = value;
			},
		};
		context.setEditorComponent(() => custom);
		custom.setText("plain custom text");
		context.setEditorComponent(undefined);
		expect(editor.getExpandedText()).toBe("plain custom text");
	});

	it("dequeues messages without losing the editor's expanded paste", async () => {
		const { mode, context, editor } = await setup();
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		Reflect.set(mode, "compactionQueuedMessages", [{ text: "queued", mode: "steer" }]);
		const restore = Reflect.get(mode, "restoreQueuedMessagesToEditor") as () => number;
		expect(restore.call(mode)).toBe(1);
		expect(context.getEditorText()).toBe(`queued\n\n${paste}`);
	});
});
