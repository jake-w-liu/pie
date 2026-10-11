import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	initTheme,
	loadThemeFromPath,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	setCapabilityOverrides({});
	resetCapabilitiesCache();
	stopThemeWatcher();
	onThemeChange(() => {});
	setRegisteredThemes([]);
	initTheme("dark");
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("external theme hot reload", () => {
	it("watches the registered source path rather than the global theme directory", async () => {
		// The reload path rebuilds colors from the detected terminal capability, so
		// pin truecolor instead of depending on the ambient COLORTERM of the runner.
		setCapabilityOverrides({ trueColor: true });
		const directory = mkdtempSync(join(tmpdir(), "pi-theme-hot-reload-"));
		temporaryDirectories.push(directory);
		const sourcePath = join(import.meta.dirname, "../src/modes/interactive/theme/dark.json");
		const externalPath = join(directory, "filename-differs-from-theme-name.json");
		const definition = JSON.parse(readFileSync(sourcePath, "utf8")) as {
			name: string;
			colors: { accent: string };
		};
		definition.name = "external-theme";
		definition.colors.accent = "#112233";
		writeFileSync(externalPath, JSON.stringify(definition));
		setRegisteredThemes([loadThemeFromPath(externalPath, "truecolor")]);
		const changed = vi.fn();
		onThemeChange(changed);

		expect(setTheme("external-theme", true)).toEqual({ success: true });
		changed.mockClear();
		// Give the platform watcher a turn before mutating the file.
		await new Promise((resolve) => setTimeout(resolve, 100));
		definition.colors.accent = "#abcdef";
		writeFileSync(externalPath, JSON.stringify(definition));

		await vi.waitFor(
			() => {
				expect(theme.getFgAnsi("accent")).toContain("171;205;239");
				expect(changed).toHaveBeenCalled();
			},
			{ timeout: 3000, interval: 50 },
		);
	});
});
