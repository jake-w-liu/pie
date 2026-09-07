import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { normalizeCount } from "./stack.ts";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = normalizeCount(paddingX, 0);
		this.paddingY = normalizeCount(paddingY, 0);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// Reduce margins when necessary so content and padding fit within the
		// available width (mirrors Text's padding clamp).
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - paddingX * 2);

		// Take only the first line (stop at any newline sequence)
		let singleLineText = this.text;
		const newlineIndex = this.text.search(/\r\n|\r|\n/);
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = " ".repeat(paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Pad line to exactly width characters
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
