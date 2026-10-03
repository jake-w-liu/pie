import { describe, expect, it, vi } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { createInteractiveHarness, deferred } from "./tui-audit-helpers.ts";

describe("interactive bash submission race", () => {
	it("rejects a second bash submission while the first is still in flight", async () => {
		const h = await createInteractiveHarness();
		try {
			const extension1 = deferred<undefined>();
			const extension2 = deferred<undefined>();
			vi.spyOn(h.session.extensionRunner, "emitUserBash")
				.mockReturnValueOnce(extension1.promise)
				.mockReturnValueOnce(extension2.promise);
			const execute1 = deferred<{ output: string; exitCode: number; cancelled: boolean; truncated: boolean }>();
			const execute2 = deferred<{ output: string; exitCode: number; cancelled: boolean; truncated: boolean }>();
			const callbacks: Array<(chunk: string) => void> = [];
			vi.spyOn(h.session, "executeBash").mockImplementation((_command, callback) => {
				if (callback) callbacks.push(callback);
				return callbacks.length === 1 ? execute1.promise : execute2.promise;
			});
			const setup = Reflect.get(h.mode, "setupEditorSubmitHandler") as () => void;
			setup.call(h.mode);
			const submit = h.editor.onSubmit as unknown as (text: string) => Promise<void>;
			const first = submit("!first");
			const second = submit("!second");
			extension1.resolve(undefined);
			await Promise.resolve();
			await Promise.resolve();
			extension2.resolve(undefined);
			await Promise.resolve();
			await Promise.resolve();
			expect(callbacks).toHaveLength(1);
			const components = h.chat.children.filter((c) => c instanceof BashExecutionComponent);
			// The second submission is rejected while the first is still in flight.
			expect(components).toHaveLength(1);
			callbacks[0]!("FIRST-OUTPUT-SENTINEL");
			// Output stays on the component that owns the execution.
			expect(components[0]!.render(80).join("\n")).toContain("FIRST-OUTPUT-SENTINEL");
			execute1.resolve({ output: "", exitCode: 0, cancelled: false, truncated: false });
			execute2.resolve({ output: "", exitCode: 0, cancelled: false, truncated: false });
			await Promise.all([first, second]);
		} finally {
			h.cleanup();
		}
	});
});
