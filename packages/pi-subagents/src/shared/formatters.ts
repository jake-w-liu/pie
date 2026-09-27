/**
 * Formatting utilities for display output
 */

import type { Usage, TokenUsage } from "./types.ts";
import { isDynamicParallelStep, isParallelStep } from "./settings.ts";
import { previewDisplayText, sanitizeDisplayText } from "./display-text.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.ts";

/**
 * Format token count with k suffix for large numbers
 */
export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function formatTokenUsage(usage: TokenUsage, legacyLabel = "tok"): string {
	return usage.window !== undefined
		? `${formatTokens(usage.window)} window · ${formatTokens(usage.total)} spent`
		: `${formatTokens(usage.total)} ${legacyLabel}`;
}
export function formatContextUsage(usage: Pick<TokenUsage, "window" | "windowPeak">, contextLimit: number): string | undefined {
	if (usage.window === undefined || !Number.isFinite(usage.window) || !Number.isFinite(contextLimit) || contextLimit <= 0) return undefined;
	const peak = usage.windowPeak !== undefined && Number.isFinite(usage.windowPeak) ? usage.windowPeak : usage.window;
	const used = Math.max(0, usage.window, peak);
	return `ctx ${formatTokens(used)}/${formatTokens(contextLimit)} (${Math.round((used / contextLimit) * 100)}%)`;
}

export function formatModelThinking(model?: string, thinking?: string): string {
	const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
	let displayModel = parsed?.baseModel ?? model;
	const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
	const displayThinking = parsed?.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : explicitThinking;
	if (displayModel) {
		const slashIdx = displayModel.lastIndexOf("/");
		if (slashIdx !== -1) displayModel = displayModel.slice(slashIdx + 1);
	}
	return [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined].filter(Boolean).join(" · ");
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
	// Whole seconds (or minutes:seconds), never tenths of a second. Sub-second
	// precision changes the rendered text every ~100ms and forces the renderer to
	// repaint the status row continuously while an agent works; whole seconds is
	// the correct duration format and updates at most once per second.
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * Format a tool call for display
 */
export function formatToolCall(name: string, args: Record<string, unknown>, expanded = false): string {
	switch (name) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "";
			return `$ ${previewDisplayText(command, expanded ? 240 : 60)}`;
		}
		case "read":
		case "write":
		case "edit": {
			const target = typeof args.path === "string"
				? args.path
				: typeof args.file_path === "string"
					? args.file_path
					: "";
			return `${name} ${sanitizeDisplayText(shortenPath(target))}`;
		}
		default: {
			return `${name} ${previewDisplayText(JSON.stringify(args), expanded ? 160 : 40)}`;
		}
	}
}

/**
 * Shorten a path by replacing home directory with ~
 */
export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}
