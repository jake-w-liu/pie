import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;

	// =========================================================================
	// Mouse support (optional)
	// =========================================================================

	/**
	 * Position the editor cursor at a terminal screen coordinate relative to this
	 * component's layout box top-left. Used for mouse click-to-position. Returns
	 * false when the click falls outside the editable content area.
	 */
	positionCursorAtScreen?(boxX: number, boxY: number, boxWidth: number): boolean;

	/**
	 * Begin a mouse selection at a terminal screen coordinate relative to this
	 * component's layout box top-left. Used for click-and-drag range selection.
	 * Returns whether the position was inside the content area.
	 */
	beginMouseSelection?(boxX: number, boxY: number, boxWidth: number): boolean;

	/**
	 * Extend an in-progress mouse selection to a new screen coordinate (drag),
	 * relative to this component's layout box top-left.
	 */
	extendMouseSelection?(boxX: number, boxY: number, boxWidth: number): boolean;

	/**
	 * Complete a mouse selection and return the selected text, or null when there
	 * is no non-empty selection.
	 */
	endMouseSelection?(): string | null;

	/** Clear any active mouse selection highlight. */
	clearMouseSelection?(): void;
}
