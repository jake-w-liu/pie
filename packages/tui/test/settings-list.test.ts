import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("navigates to a filtered-out item when a submenu closes with navigateTo", () => {
		const opened: string[] = [];
		let alphaDone: ((v?: string, o?: { navigateTo?: string }) => void) | undefined;
		const makeItem = (id: string) => ({
			id,
			label: id === "alpha" ? "Alpha setting" : "Beta setting",
			currentValue: "",
			submenu: (_value: string, done: (v?: string, o?: { navigateTo?: string }) => void) => {
				opened.push(id);
				if (id === "alpha") alphaDone = done;
				return { render: () => [id], invalidate: () => {} };
			},
		});
		const list = new SettingsList(
			[makeItem("alpha"), makeItem("beta")],
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);

		// Search to filter out "beta".
		for (const character of "Alph") list.handleInput(character);
		assert.strictEqual(list.render(80).filter((l) => l.includes("Beta")).length, 0, "beta should be filtered out");

		// Open alpha's submenu.
		list.handleInput("\r");
		assert.deepStrictEqual(opened, ["alpha"]);
		assert.ok(alphaDone, "alpha submenu should capture its done callback");

		// Close it navigating to the filtered-out beta: beta's submenu must open.
		alphaDone(undefined, { navigateTo: "beta" });
		assert.deepStrictEqual(opened, ["alpha", "beta"]);
	});

	it("renders without throwing at boundary widths below 5 columns", () => {
		// Regression coverage for B1: at terminal widths < 5 the value column
		// collapses (valueMaxWidth <= 0) and the description wraps at width - 4
		// (<= 0). Both helpers degrade gracefully (empty truncation / FFFD
		// fallback), so rendering must neither throw nor hang — output is
		// cosmetic-only at these widths. The TUI framework itself guarantees
		// width >= 1 for component renders (tui.ts resolveOverlayLayout clamps).
		const narrowItems = [
			{
				id: "tui-mode",
				label: "TUI mode with a long label",
				description: "A description that must wrap even when almost no columns remain",
				currentValue: "regular",
				values: ["regular", "fullscreen"],
			},
		];
		for (const width of [1, 2, 3, 4]) {
			const list = new SettingsList(
				narrowItems.map((item) => ({ ...item })),
				10,
				testTheme,
				() => {},
				() => {},
			);
			const lines = list.render(width);
			assert.ok(lines.length > 0, `expected lines at width ${width}`);
		}
	});
});
