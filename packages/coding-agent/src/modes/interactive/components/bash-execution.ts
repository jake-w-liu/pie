/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Spacer, sliceByColumn, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

function selectVisualTail(lines: string[], width: number, paddingX: number, maxVisualLines: number): string[] {
	const contentWidth = Math.max(1, width - paddingX * 2);
	const selected: string[] = [];
	let remaining = maxVisualLines;
	for (let index = lines.length - 1; index >= 0 && remaining > 0; index--) {
		const line = lines[index]!;
		const lineWidth = visibleWidth(line);
		const visualLines = Math.max(1, Math.ceil(lineWidth / contentWidth));
		if (visualLines <= remaining) {
			selected.unshift(line);
			remaining -= visualLines;
			continue;
		}
		const keepColumns = remaining * contentWidth;
		selected.unshift(sliceByColumn(line, Math.max(0, lineWidth - keepColumns), keepColumns, true));
		remaining = 0;
	}
	return selected;
}

function takeLastLogicalLines(text: string, maxLines: number): string[] {
	if (!text) return [];
	const content = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (!content) return [""];
	let start = content.length;
	for (let count = 0; count < maxLines; count++) {
		const newline = content.lastIndexOf("\n", start - 1);
		if (newline < 0) {
			start = 0;
			break;
		}
		start = newline;
	}
	if (start > 0 && content[start] === "\n") start++;
	return content.slice(start).split("\n");
}

export class BashExecutionComponent extends Container {
	private command: string;
	private outputTail = "";
	private outputTailBytes = 0;
	private outputTailLineBreaks = 0;
	private totalLineBreaks = 0;
	private hasOutput = false;
	private outputEndsWithNewline = false;
	private outputWasTruncated = false;
	private displayDirty = false;
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Command header
		const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// Loader
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // Plain text for loader
		);
		this.contentContainer.addChild(this.loader);

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.displayDirty = true;
	}

	override invalidate(): void {
		super.invalidate();
		this.displayDirty = true;
	}

	override render(width: number): string[] {
		if (this.displayDirty) {
			this.updateDisplay();
			this.displayDirty = false;
		}
		return super.render(width);
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings. The executor owns the exact/full
		// output; this component retains only the bounded tail needed for display.
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!clean) return;

		this.hasOutput = true;
		let chunkLineBreaks = 0;
		for (let index = 0; index < clean.length; index++) {
			if (clean.charCodeAt(index) === 10) chunkLineBreaks++;
		}
		this.totalLineBreaks += chunkLineBreaks;
		this.outputTailLineBreaks += chunkLineBreaks;
		this.outputTailBytes += Buffer.byteLength(clean, "utf8");
		this.outputEndsWithNewline = clean.endsWith("\n");
		this.outputTail += clean;
		if (this.outputTailBytes > DEFAULT_MAX_BYTES * 2 || this.outputTailLineBreaks > DEFAULT_MAX_LINES * 2) {
			this.compactOutputTail();
		}
		this.displayDirty = true;
	}

	private compactOutputTail(): void {
		if (this.outputTailBytes <= DEFAULT_MAX_BYTES && this.outputTailLineBreaks <= DEFAULT_MAX_LINES) return;
		const endedWithNewline = this.outputTail.endsWith("\n");
		const bounded = truncateTail(this.outputTail, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		this.outputWasTruncated ||= bounded.truncated;
		this.outputTail = bounded.content;
		if (endedWithNewline && this.outputTail && !this.outputTail.endsWith("\n")) this.outputTail += "\n";
		this.outputTailBytes = Buffer.byteLength(this.outputTail, "utf8");
		this.outputTailLineBreaks = 0;
		for (let index = 0; index < this.outputTail.length; index++) {
			if (this.outputTail.charCodeAt(index) === 10) this.outputTailLineBreaks++;
		}
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();
		this.displayDirty = true;
	}

	private updateDisplay(): void {
		this.compactOutputTail();
		const totalLineCount = this.hasOutput ? this.totalLineBreaks + (this.outputEndsWithNewline ? 0 : 1) : 0;
		const retainedLineCount = this.outputTail
			? this.outputTailLineBreaks + (this.outputTail.endsWith("\n") ? 0 : 1)
			: 0;
		const omittedLineCount = Math.max(0, totalLineCount - retainedLineCount);
		const availableLines = this.expanded
			? this.outputTail.replace(/\n$/, "").split("\n")
			: takeLastLogicalLines(this.outputTail, PREVIEW_LINES);
		const previewLogicalLines = this.expanded ? availableLines.slice(-PREVIEW_LINES) : availableLines;
		const hiddenLineCount = this.expanded
			? Math.max(0, retainedLineCount - PREVIEW_LINES)
			: Math.max(0, totalLineCount - previewLogicalLines.length);

		// Rebuild content container
		this.contentContainer.clear();

		// Command header
		const header = new Text(theme.fg("bashMode", theme.bold(`$ ${this.command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// Select only enough logical tail content to fill the visual preview before wrapping.
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const selected = selectVisualTail(previewLogicalLines, width, 1, PREVIEW_LINES);
							const styledOutput = selected.map((line) => theme.fg("muted", line)).join("\n");
							const result = truncateToVisualLines(`\n${styledOutput}`, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			if (omittedLineCount > 0 && this.expanded) {
				statusParts.push(theme.fg("warning", `${omittedLineCount} earlier lines omitted from the UI buffer.`));
			}

			// Add truncation warning (executor/context or bounded UI-tail truncation).
			const wasTruncated = this.truncationResult?.truncated || this.outputWasTruncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/** Get the bounded display tail. Exact output is owned by the bash executor result. */
	getOutput(): string {
		this.compactOutputTail();
		return this.outputTail;
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
