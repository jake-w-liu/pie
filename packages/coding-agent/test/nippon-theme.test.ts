import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getAvailableThemes,
	getResolvedThemeColors,
	isLightTheme,
	loadThemeFromPath,
	resolveBuiltinThemeName,
} from "../src/modes/interactive/theme/theme.ts";

interface NipponThemeFile {
	name: string;
	vars: Record<string, string>;
	colors: Record<string, string | number>;
	export?: Record<string, string | number>;
}

const themeUrls = [
	new URL("../src/modes/interactive/theme/pie-nippon-dark.json", import.meta.url),
	new URL("../src/modes/interactive/theme/pie-nippon-light.json", import.meta.url),
];

function readTheme(url: URL): NipponThemeFile {
	return JSON.parse(readFileSync(url, "utf8")) as NipponThemeFile;
}

function resolveColor(theme: NipponThemeFile, value: string | number): string {
	if (typeof value !== "string") throw new Error("Nippon themes must use named colors");
	return theme.vars[value] ?? value;
}

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(left: string, right: string): number {
	const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
	return (lighter! + 0.05) / (darker! + 0.05);
}

describe("Pie Nippon themes", () => {
	it("loads both complete built-in themes", () => {
		const names = themeUrls.map((url) => loadThemeFromPath(fileURLToPath(url), "truecolor").name);
		expect(names).toEqual(["pie-nippon-dark", "pie-nippon-light"]);
		expect(getAvailableThemes()).toEqual(expect.arrayContaining(names));
		expect(getResolvedThemeColors("pie-nippon-dark").accent).toBe("#78C2C4");
		expect(getResolvedThemeColors("pie-nippon-light").accent).toBe("#0C4842");
	});

	it("maps Pie dark and light selections without changing normal Pi", () => {
		expect(resolveBuiltinThemeName("dark", "pie")).toBe("pie-nippon-dark");
		expect(resolveBuiltinThemeName("light", "pie")).toBe("pie-nippon-light");
		expect(resolveBuiltinThemeName("dark", "pi")).toBe("dark");
		expect(resolveBuiltinThemeName("light", "pi")).toBe("light");
		expect(isLightTheme("pie-nippon-light")).toBe(true);
		expect(isLightTheme("pie-nippon-dark")).toBe(false);
	});

	it("uses only named Nippon palette values for every color token", () => {
		for (const url of themeUrls) {
			const theme = readTheme(url);
			for (const value of Object.values(theme.vars)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
			for (const value of [...Object.values(theme.colors), ...Object.values(theme.export ?? {})]) {
				expect(typeof value).toBe("string");
				expect(theme.vars).toHaveProperty(String(value));
			}
		}
	});

	it("keeps semantic text and message content at accessible contrast", () => {
		const foregroundTokens = ["accent", "success", "error", "warning", "muted", "text"];
		const backgroundPairs = [
			["userMessageText", "userMessageBg"],
			["customMessageText", "customMessageBg"],
			["toolTitle", "toolPendingBg"],
			["toolTitle", "toolSuccessBg"],
			["toolTitle", "toolErrorBg"],
			["searchMatchText", "searchMatchBg"],
		];
		for (const url of themeUrls) {
			const theme = readTheme(url);
			const page = resolveColor(theme, theme.export!.pageBg);
			for (const token of foregroundTokens) {
				expect(
					contrastRatio(resolveColor(theme, theme.colors[token]!), page),
					`${theme.name}:${token}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			for (const [foreground, background] of backgroundPairs) {
				expect(
					contrastRatio(
						resolveColor(theme, theme.colors[foreground!]!),
						resolveColor(theme, theme.colors[background!]!),
					),
					`${theme.name}:${foreground}/${background}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});
