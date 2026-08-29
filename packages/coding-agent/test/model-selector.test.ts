import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(rows = 30): TUI {
	return { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps narrow-terminal selector height bounded", async () => {
		harness = await createHarness({
			models: Array.from({ length: 20 }, (_, index) => ({
				id: `model-${index}-${"x".repeat(80)}`,
				name: `Model ${index} ${"Long Name ".repeat(10)}`,
			})),
		});
		const selector = new ModelSelectorComponent(
			createFakeTui(20),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			() => {},
		);

		const lines = selector.render(40);
		expect(lines.length).toBeLessThanOrEqual(18);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
