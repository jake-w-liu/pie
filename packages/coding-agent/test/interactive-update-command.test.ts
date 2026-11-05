import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import type * as SelfUpdateModule from "../src/modes/interactive/self-update.ts";
import type { PieUpdateResult } from "../src/modes/interactive/self-update.ts";
import { createInteractiveHarness, deferred } from "./tui-audit-helpers.ts";

// The real module would run scripts/update-pie.sh against the installed Pie checkout.
const selfUpdate = vi.hoisted(() => ({
	resolvePieSourceCheckout: vi.fn(),
	runPieUpdate: vi.fn(),
}));
vi.mock("../src/modes/interactive/self-update.ts", async (importOriginal) => ({
	...(await importOriginal<typeof SelfUpdateModule>()),
	resolvePieSourceCheckout: selfUpdate.resolvePieSourceCheckout,
	runPieUpdate: selfUpdate.runPieUpdate,
}));

type Harness = Awaited<ReturnType<typeof createInteractiveHarness>>;
type UpdateOptions = { signal?: AbortSignal; onOutput?: (chunk: string) => void };

const checkout = { ok: true as const, repository: "/src/pie", updateScript: "/src/pie/scripts/update-pie.sh" };

beforeEach(() => {
	selfUpdate.resolvePieSourceCheckout.mockReset().mockReturnValue(checkout);
	selfUpdate.runPieUpdate.mockReset();
});

async function withHarness(run: (h: Harness, submit: (text: string) => Promise<void>) => Promise<void>) {
	const h = await createInteractiveHarness();
	try {
		const setup = Reflect.get(h.mode, "setupEditorSubmitHandler") as () => void;
		setup.call(h.mode);
		await run(h, h.editor.onSubmit as unknown as (text: string) => Promise<void>);
	} finally {
		h.cleanup();
	}
}

/** Start /update with a pending update run; returns its controls once the loader is shown. */
async function startUpdate(h: Harness, submit: (text: string) => Promise<void>) {
	const run = deferred<PieUpdateResult>();
	let options: UpdateOptions = {};
	selfUpdate.runPieUpdate.mockImplementation((_checkout: unknown, updateOptions: UpdateOptions) => {
		options = updateOptions;
		return run.promise;
	});
	const submitted = submit("/update");
	await vi.waitFor(() => expect(selfUpdate.runPieUpdate).toHaveBeenCalledTimes(1));
	const loader = h.editorContainer.children[0];
	expect(loader).toBeInstanceOf(BorderedLoader);
	return { run, submitted, loader: loader as BorderedLoader, options: () => options };
}

const chatText = (h: Harness) => h.chat.render(200).join("\n");

describe.skipIf(process.platform === "win32")("/update", () => {
	it("shows progress, then reports the installed version and restores the editor", async () => {
		await withHarness(async (h, submit) => {
			const { run, submitted, loader, options } = await startUpdate(h, submit);
			expect(selfUpdate.runPieUpdate).toHaveBeenCalledWith(checkout, expect.anything());
			expect(loader.render(200).join("\n")).toContain(`Updating ${APP_NAME} from /src/pie...`);

			options().onOutput?.("Fetching refs/heads/main from origin...\n\u001b[32mBuilding\u001b[0m 40%\r");
			expect(loader.render(200).join("\n")).toContain(`Updating ${APP_NAME}: Building 40%`);

			run.resolve({ code: 0, signal: null, output: "Installed Pie 0.1.4 from abc123def456\nLauncher: /x\n" });
			await submitted;
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(chatText(h)).toContain("Installed Pie 0.1.4 from abc123def456. Restart Pie sessions to use it.");
		});
	});

	it("reports a failed update with the end of its output", async () => {
		await withHarness(async (h, submit) => {
			const { run, submitted } = await startUpdate(h, submit);
			run.resolve({ code: 1, signal: null, output: "Fetching...\nerror: main has diverged from origin\n" });
			await submitted;
			expect(h.editorContainer.children).toEqual([h.editor]);
			const chat = chatText(h);
			expect(chat).toContain("Update failed (exit code 1):");
			expect(chat).toContain("error: main has diverged from origin");
		});
	});

	it("cancels the running update from the loader", async () => {
		await withHarness(async (h, submit) => {
			const { run, submitted, loader, options } = await startUpdate(h, submit);
			loader.handleInput("\u001b");
			expect(options().signal?.aborted).toBe(true);
			run.resolve({ code: null, signal: "SIGTERM", output: "" });
			await submitted;
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(chatText(h)).toContain("Update cancelled.");
		});
	});

	it("explains why an installation cannot be updated", async () => {
		await withHarness(async (h, submit) => {
			selfUpdate.resolvePieSourceCheckout.mockReturnValue({ ok: false, error: "No source checkout recorded." });
			await submit("/update");
			expect(selfUpdate.runPieUpdate).not.toHaveBeenCalled();
			expect(h.editorContainer.children).toEqual([h.editor]);
			expect(chatText(h)).toContain("Error: No source checkout recorded.");
		});
	});

	it("waits for a running response or compaction to finish", async () => {
		await withHarness(async (h, submit) => {
			const streaming = vi.spyOn(h.session, "isStreaming", "get").mockReturnValue(true);
			await submit("/update");
			expect(chatText(h)).toContain("Wait for the current response to finish before updating.");
			streaming.mockReturnValue(false);

			vi.spyOn(h.session, "isCompacting", "get").mockReturnValue(true);
			await submit("/update");
			expect(chatText(h)).toContain("Wait for compaction to finish before updating.");

			expect(selfUpdate.resolvePieSourceCheckout).not.toHaveBeenCalled();
			expect(selfUpdate.runPieUpdate).not.toHaveBeenCalled();
			expect(h.editorContainer.children).toEqual([h.editor]);
		});
	});
});
