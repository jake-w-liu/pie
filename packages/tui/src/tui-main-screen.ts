import * as fs from "node:fs";
import * as path from "node:path";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import {
	BoundedTerminalWriter,
	type Component,
	Container,
	isPrimaryMouseRelease,
	type TUI,
	TuiBase,
	type TuiStopOptions,
} from "./tui.ts";
import {
	getGraphemeCellRange,
	getWordSegmenter,
	normalizeTerminalOutput,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";

// Wheel notches per scroll step while reading back.
const WHEEL_SCROLL_LINES = 3;

// Multi-press timing and word-join characters mirror fullscreen selection.
const DOUBLE_CLICK_INTERVAL_MS = 500;
const SELECTION_JOINERS = new Set(["/", "-"]);
const wordSegmenter = getWordSegmenter();

/** Selection endpoint: absolute content row with an exact visible column. */
interface SelectionEndpoint {
	row: number;
	col: number;
}

interface PendingDrag {
	row: number;
	col: number;
	endCol: number;
	pressX: number;
	count: number;
}

interface SelectionBounds {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
}

/** Wrap visible text in inverse video, re-applying it after inner SGR codes. */
function applyInverseVideo(text: string): string {
	let result = "\x1b[7m";
	for (const segment of text.split(/(\x1b\[[0-9;]*m)/g)) {
		if (!segment) continue;
		result += segment;
		if (/^\x1b\[[0-9;]*m$/.test(segment)) result += "\x1b[7m";
	}
	return `${result}\x1b[27m`;
}

function highlightRange(line: string, startCol: number, endCol: number): string {
	const width = visibleWidth(line);
	const start = Math.max(0, Math.min(startCol, width));
	const end = Math.max(0, Math.min(endCol, width));
	if (end <= start) return line;
	const before = sliceByColumn(line, 0, start, true);
	const middle = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, width - end), true);
	return `${before}${applyInverseVideo(middle)}${after}`;
}

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const LINE_RESET = "\x1b[0m\x1b]8;;\x07";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Rows rendered after `target` within `roots`, or undefined when `target` is
 * not mounted under `roots`. Walks bottom-up so callers can stop before
 * reaching (potentially huge) transcript content above the target.
 */
function measureRowsAfter(roots: readonly Component[], target: Component, width: number): number | undefined {
	let after = 0;
	for (let index = roots.length - 1; index >= 0; index--) {
		const child = roots[index]!;
		if (child === target) return after;
		if (child instanceof Container) {
			const inner = measureRowsAfter(child.children, target, width);
			if (inner !== undefined) return after + inner;
		}
		after += child.render(width).length;
	}
	return undefined;
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

export interface TuiMainScreenOptions {
	/**
	 * Copy selected text to the system clipboard. Return `true` on success;
	 * the caller falls back to an OSC 52 write otherwise. When omitted, the
	 * selection is copied via an OSC 52 write.
	 */
	copySelection?: (text: string) => Promise<boolean>;
}
/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private readonly copySelection?: (text: string) => Promise<boolean>;
	private previousLines: string[] = [];
	private previousRawLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	// Set synchronously by lifecycle callbacks so pointer events cannot target
	// an uncommitted resized or overlaid frame.
	private terminalGeometryInvalidated = false;
	private overlayFrameInvalidated = false;
	// Reading and selection holds are independent: selecting while scrolled
	// back must not discard the user's explicit reading position.
	private readingViewport = false;
	// Text selection endpoints (absolute content rows, exact visible columns).
	private selectionAnchor: SelectionEndpoint | undefined;
	private selectionFocus: SelectionEndpoint | undefined;
	// Selection changes are painted by the throttled render pipeline. The
	// accumulated row union keeps rapid drag events to at most one write/frame.
	private selectionRepaintStartRow: number | undefined;
	private selectionRepaintEndRow: number | undefined;
	// In-progress drag from the latest press; coordinates share the selection form.
	private pendingDrag: PendingDrag | undefined;
	private lastClick: { timestamp: number; count: number; row: number; wordStart: number; wordEnd: number } | undefined;
	// Coalesce clipboard requests produced by one burst without waiting on older
	// callbacks, which may be slow or never settle.
	private pendingSelectionCopy: { text: string; request: number } | undefined;
	private selectionCopyScheduled = false;
	private selectionCopyGeneration = 0;
	private selectionCopyRequest = 0;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiMainScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.copySelection = options.copySelection;
	}

	/**
	 * Append a mouse/viewport diagnostics line when PI_DEBUG_MOUSE=1.
	 * Never throws: diagnostics must not break input handling.
	 */
	private logMouse(event: string, detail = ""): void {
		if (process.env.PI_DEBUG_MOUSE !== "1") return;
		try {
			const logPath = path.join(this.logDirectory, "pi-mouse.log");
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			const anchor = this.selectionAnchor ? `${this.selectionAnchor.row},${this.selectionAnchor.col}` : "-";
			const focus = this.selectionFocus ? `${this.selectionFocus.row},${this.selectionFocus.col}` : "-";
			const pending = this.pendingDrag ? `${this.pendingDrag.row},${this.pendingDrag.col}` : "-";
			const hold = this.readingViewport
				? this.pendingDrag
					? "reading+selection"
					: "reading"
				: this.pendingDrag
					? "selection"
					: "none";
			const state =
				`prevTop=${this.previousViewportTop} hwRow=${this.hardwareCursorRow} ` +
				`hold=${hold} lines=${this.previousLines.length} ` +
				`sel=${anchor}:${focus} pending=${pending}`;
			fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${event}${detail ? ` ${detail}` : ""} | ${state}\n`);
		} catch {
			// Diagnostics must never break input handling.
		}
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousRawLines = [];
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
		this.readingViewport = false;
		if (this.pendingDrag) {
			this.selectionAnchor = undefined;
			this.selectionFocus = undefined;
			this.lastClick = undefined;
		}
		this.pendingDrag = undefined;
		this.selectionRepaintStartRow = undefined;
		this.selectionRepaintEndRow = undefined;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousRawLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.readingViewport = false;
		this.selectionRepaintStartRow = undefined;
		this.selectionRepaintEndRow = undefined;
		// A partial selection cannot survive a render-state reset.
		if (this.pendingDrag) {
			this.selectionAnchor = undefined;
			this.selectionFocus = undefined;
			this.lastClick = undefined;
		}
		this.pendingDrag = undefined;
	}

	private hasStalePointerFrame(): boolean {
		return (
			this.terminalGeometryInvalidated ||
			this.overlayFrameInvalidated ||
			this.terminal.columns !== this.previousWidth ||
			this.terminal.rows !== this.previousHeight
		);
	}

	override routeMousePress(x: number, y: number): void {
		// Click coordinates are stale across a resize until the re-render lands.
		// Cancel a half-open gesture and request a fresh frame rather than
		// interpreting the new press against stale geometry.
		if (this.hasStalePointerFrame()) {
			this.cancelSelectionGestureForRerender();
			this.requestRender();
			return;
		}
		const total = this.previousLines.length;
		if (total === 0) return;
		// Overlays cover the base content, so base clicks have no valid target.
		if (this.hasOverlay()) {
			this.cancelSelectionGestureForRerender();
			this.requestRender();
			return;
		}
		const absoluteRow = this.previousViewportTop + y;
		if (absoluteRow < 0 || absoluteRow >= total) return;
		this.logMouse("press", `x=${x} y=${y} abs=${absoluteRow}`);
		const focused = this.getFocusedComponent();
		if (focused) {
			const width = this.terminal.columns;
			const after = measureRowsAfter(this.children, focused, width);
			if (after !== undefined) {
				const targetHeight = focused.render(width).length;
				const localFromBottom = total - 1 - absoluteRow - after;
				if (localFromBottom >= 0 && localFromBottom < targetHeight) {
					// An editor press ends a half-open transcript gesture before
					// moving the cursor. Otherwise its release cannot resume rendering.
					this.clearSelection();
					this.resumeViewport();
					if (
						typeof focused.handleMousePress === "function" &&
						focused.handleMousePress(x, targetHeight - 1 - localFromBottom)
					) {
						this.requestRender();
					}
					this.logMouse("press-editor");
					return;
				}
			}
		}
		// A second press without a release supersedes the old gesture and must
		// not be mistaken for a valid double-click sequence.
		if (this.pendingDrag) this.lastClick = undefined;
		this.handleTranscriptPress(x, absoluteRow);
		this.logMouse("press-transcript");
	}

	override routeMouseRelease(x: number, y: number, button = 0): boolean {
		if (!isPrimaryMouseRelease({ button, x, y, press: false })) {
			this.cancelSelectionGestureForRerender();
			return true;
		}
		if (this.hasOverlay() || this.hasStalePointerFrame()) {
			this.cancelSelectionGestureForRerender();
			this.requestRender();
			return true;
		}
		const total = this.previousLines.length;
		if (total === 0) {
			this.cancelSelectionGestureForRerender();
			return true;
		}
		const pending = this.pendingDrag;
		this.pendingDrag = undefined;
		if (!pending) return true;
		const row = Math.max(0, Math.min(total - 1, this.previousViewportTop + y));
		this.logMouse("release", `x=${x} y=${y} row=${row} count=${pending.count}`);
		if (row === pending.row && x === pending.pressX) {
			// Multi-press selections made on press stand; a single click clears
			// the selection. Every release ends the transient selection hold.
			if (pending.count === 1) this.clearSelection();
			this.requestRender();
			return true;
		}
		this.lastClick = undefined;
		this.updateDragSelection(pending, x, row);
		this.copySelectionToClipboard();
		this.requestRender();
		return true;
	}

	override routeMouseDrag(x: number, y: number): boolean {
		const pending = this.pendingDrag;
		if (!pending) return false;
		if (this.hasOverlay() || this.hasStalePointerFrame()) {
			this.cancelSelectionGestureForRerender();
			this.requestRender();
			return true;
		}
		const total = this.previousLines.length;
		if (total === 0) {
			this.cancelSelectionGestureForRerender();
			return true;
		}
		const row = Math.max(0, Math.min(total - 1, this.previousViewportTop + y));
		if (row !== pending.row || x !== pending.pressX) this.lastClick = undefined;
		this.logMouse("drag", `x=${x} y=${y} row=${row}`);
		this.updateDragSelection(pending, x, row);
		return true;
	}

	private updateDragSelection(pending: PendingDrag, x: number, row: number): void {
		const backwards = row < pending.row || (row === pending.row && x < pending.pressX);
		const line = this.previousLines[row] ?? "";
		const anchorCol = backwards ? pending.endCol : pending.col;
		const focusCol = backwards ? this.snapAnchorCol(line, x) : this.snapFocusCol(line, x);
		if (
			this.selectionAnchor?.row === pending.row &&
			this.selectionAnchor.col === anchorCol &&
			this.selectionFocus?.row === row &&
			this.selectionFocus.col === focusCol
		)
			return;
		this.setSelection({ row: pending.row, col: anchorCol }, { row, col: focusCol });
	}

	protected override routeMouseCancel(): void {
		this.cancelSelectionGestureForRerender();
	}

	protected override routeTerminalFocusChange(focused: boolean): void {
		if (focused || !this.pendingDrag) return;
		this.logMouse("focus-out");
		this.cancelSelectionGestureForRerender();
	}

	protected override routeTerminalResize(): void {
		this.terminalGeometryInvalidated = true;
		this.cancelSelectionGestureForRerender();
		super.routeTerminalResize();
	}

	protected override routeOverlayChange(): void {
		this.overlayFrameInvalidated = true;
		this.readingViewport = false;
		this.cancelSelectionGestureForRerender();
		this.requestRender();
	}

	private cancelSelectionGestureForRerender(): void {
		if (!this.pendingDrag) return;
		this.pendingDrag = undefined;
		this.lastClick = undefined;
		this.clearSelection();
		this.requestRender();
	}

	private handleTranscriptPress(x: number, absoluteRow: number): void {
		const total = this.previousLines.length;
		const row = Math.max(0, Math.min(total - 1, absoluteRow));
		const clampedX = Math.max(0, Math.min(this.terminal.columns - 1, x));
		const word = this.getWordAt(row, clampedX);
		const count = this.countPress(row, word);
		if (!word) {
			this.clearSelection();
			this.pendingDrag = { row, col: clampedX, endCol: clampedX, pressX: clampedX, count };
			return;
		}
		if (count === 1) {
			this.clearSelection();
			this.pendingDrag = {
				row,
				col: this.snapAnchorCol(this.previousLines[row] ?? "", clampedX),
				endCol: this.snapFocusCol(this.previousLines[row] ?? "", clampedX),
				pressX: clampedX,
				count,
			};
			return;
		}
		if (count === 2) {
			this.pendingDrag = { row, col: word.startCol, endCol: word.endCol, pressX: clampedX, count };
			this.setSelection({ row, col: word.startCol }, { row, col: word.endCol });
		} else {
			const lineWidth = visibleWidth(stripTerminalSequences(this.previousLines[row] ?? ""));
			this.pendingDrag = { row, col: 0, endCol: lineWidth, pressX: clampedX, count };
			this.setSelection({ row, col: 0 }, { row, col: lineWidth });
		}
		this.copySelectionToClipboard();
	}

	private countPress(row: number, word: { startCol: number; endCol: number } | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === row &&
			previous.wordStart === word.startCol &&
			previous.wordEnd === word.endCol
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? { timestamp: now, count, row, wordStart: word.startCol, wordEnd: word.endCol }
			: undefined;
		return count;
	}

	private getWordAt(row: number, col: number): { startCol: number; endCol: number } | undefined {
		const plain = stripTerminalSequences(this.previousLines[row] ?? "");
		const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
		let pos = 0;
		for (const segment of wordSegmenter.segment(plain)) {
			const end = pos + visibleWidth(segment.segment);
			const joiner = SELECTION_JOINERS.has(segment.segment);
			segments.push({ start: pos, end, selectable: segment.isWordLike === true || joiner, joiner });
			pos = end;
		}
		const index = segments.findIndex((segment) => col >= segment.start && col < segment.end);
		if (index < 0) return undefined;
		const canJoin = (
			left: { selectable: boolean; joiner: boolean },
			right: { selectable: boolean; joiner: boolean },
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		let startCol = segments[index]!.start;
		let endCol = segments[index]!.end;
		for (let i = index; i > 0 && canJoin(segments[i - 1]!, segments[i]!); i--) {
			startCol = segments[i - 1]!.start;
		}
		for (let i = index; i < segments.length - 1 && canJoin(segments[i]!, segments[i + 1]!); i++) {
			endCol = segments[i + 1]!.end;
		}
		return { startCol, endCol };
	}

	private snapAnchorCol(line: string, col: number): number {
		return getGraphemeCellRange(line, col)?.start ?? Math.min(col, visibleWidth(line));
	}

	private snapFocusCol(line: string, col: number): number {
		const range = getGraphemeCellRange(line, col);
		return range ? range.end : Math.min(col + 1, visibleWidth(line));
	}

	private getOrderedSelection(): SelectionBounds | undefined {
		const anchor = this.selectionAnchor;
		const focus = this.selectionFocus;
		if (!anchor || !focus) return undefined;
		if (anchor.row === focus.row && anchor.col === focus.col) return undefined;
		return anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)
			? { startRow: anchor.row, startCol: anchor.col, endRow: focus.row, endCol: focus.col }
			: { startRow: focus.row, startCol: focus.col, endRow: anchor.row, endCol: anchor.col };
	}

	private setSelection(anchor: SelectionEndpoint, focus: SelectionEndpoint): void {
		const previous = this.getOrderedSelection();
		this.selectionAnchor = anchor;
		this.selectionFocus = focus;
		this.logMouse("setSelection", `anchor=${anchor.row},${anchor.col} focus=${focus.row},${focus.col}`);
		this.queueSelectionRepaint(previous);
	}

	private clearSelection(): void {
		if (!this.selectionAnchor) return;
		const previous = this.getOrderedSelection();
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.logMouse("clearSelection");
		this.queueSelectionRepaint(previous);
	}

	private queueSelectionRepaint(previous: SelectionBounds | undefined): void {
		const current = this.getOrderedSelection();
		const start = Math.min(
			previous?.startRow ?? Number.POSITIVE_INFINITY,
			current?.startRow ?? Number.POSITIVE_INFINITY,
		);
		const end = Math.max(previous?.endRow ?? Number.NEGATIVE_INFINITY, current?.endRow ?? Number.NEGATIVE_INFINITY);
		if (!Number.isFinite(start) || !Number.isFinite(end)) return;
		this.selectionRepaintStartRow = Math.min(this.selectionRepaintStartRow ?? start, start);
		this.selectionRepaintEndRow = Math.max(this.selectionRepaintEndRow ?? end, end);
		this.requestRender();
	}

	/** Layer inverse video over a row covered by the selection, if any. */
	private withSelectionHighlight(
		line: string,
		row: number,
		selection: SelectionBounds | undefined = this.getOrderedSelection(),
	): string {
		if (!selection || row < selection.startRow || row > selection.endRow || isImageLine(line)) {
			return line;
		}
		const start = row === selection.startRow ? selection.startCol : 0;
		const end = row === selection.endRow ? selection.endCol : visibleWidth(line);
		return highlightRange(line, start, end);
	}

	/** Paint queued selection rows from the frozen frame at render cadence. */
	private repaintSelectionRows(): boolean {
		const dirtyStart = this.selectionRepaintStartRow;
		const dirtyEnd = this.selectionRepaintEndRow;
		if (dirtyStart === undefined || dirtyEnd === undefined) return true;
		const height = this.terminal.rows;
		const start = Math.max(dirtyStart, this.previousViewportTop);
		const end = Math.min(dirtyEnd, this.previousViewportTop + height - 1, this.previousLines.length - 1);
		if (end < start) {
			this.selectionRepaintStartRow = undefined;
			this.selectionRepaintEndRow = undefined;
			return true;
		}
		const cursorScreenRow = this.hardwareCursorRow - this.previousViewportTop;
		if (cursorScreenRow < 0 || cursorScreenRow >= height) return false;
		const current = this.getOrderedSelection();
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h");
		const firstScreenRow = start - this.previousViewportTop;
		const move = firstScreenRow - cursorScreenRow;
		if (move > 0) output.append(`\x1b[${move}B`);
		else if (move < 0) output.append(`\x1b[${-move}A`);
		output.append("\r");
		for (let row = start; row <= end; row++) {
			if (row > start) output.append("\r\n");
			output.append(this.withSelectionHighlight(this.previousLines[row] ?? "", row, current));
			output.append("\x1b[K");
		}
		output.append("\x1b[?2026l");
		output.flush();
		this.hardwareCursorRow = end;
		this.selectionRepaintStartRow = undefined;
		this.selectionRepaintEndRow = undefined;
		return true;
	}

	private getSelectionText(): string | undefined {
		const selection = this.getOrderedSelection();
		if (!selection) return undefined;
		const lines: string[] = [];
		for (let row = selection.startRow; row <= selection.endRow; row++) {
			const line = this.previousLines[row] ?? "";
			const start = row === selection.startRow ? selection.startCol : 0;
			const end = row === selection.endRow ? selection.endCol : visibleWidth(line);
			// Source rows may contain styling escapes; clipboard text must not.
			lines.push(stripTerminalSequences(sliceByColumn(line, start, Math.max(0, end - start), true)).trimEnd());
		}
		const text = lines.join("\n");
		return text.length > 0 ? text : undefined;
	}

	private copySelectionToClipboard(): void {
		const text = this.getSelectionText();
		if (!text) return;
		this.selectionCopyRequest += 1;
		this.pendingSelectionCopy = { text, request: this.selectionCopyRequest };
		this.scheduleSelectionCopy();
	}

	private scheduleSelectionCopy(): void {
		if (this.selectionCopyScheduled) return;
		this.selectionCopyScheduled = true;
		const generation = this.selectionCopyGeneration;
		queueMicrotask(() => {
			this.selectionCopyScheduled = false;
			if (generation !== this.selectionCopyGeneration) {
				if (!this.stopped && this.pendingSelectionCopy !== undefined) this.scheduleSelectionCopy();
				return;
			}
			if (this.stopped) {
				this.pendingSelectionCopy = undefined;
				return;
			}
			const pending = this.pendingSelectionCopy;
			this.pendingSelectionCopy = undefined;
			if (pending !== undefined) void this.copySelectionText(pending, generation);
		});
	}

	private async copySelectionText(selection: { text: string; request: number }, generation: number): Promise<void> {
		if (this.copySelection) {
			try {
				if (await this.copySelection(selection.text)) return;
			} catch {
				// Fall through to OSC 52 while this terminal session is active.
			}
		}
		if (
			!this.stopped &&
			generation === this.selectionCopyGeneration &&
			selection.request === this.selectionCopyRequest
		) {
			this.terminal.write(`\x1b]52;c;${Buffer.from(selection.text).toString("base64")}\x07`);
		}
	}

	protected override routeMouseWheel(delta: number): boolean {
		if (this.hasOverlay()) return false;
		// Coordinates are stale across a resize until the re-render lands.
		// Request it so a missed resize can never wedge wheel handling.
		if (this.hasStalePointerFrame()) {
			this.cancelSelectionGestureForRerender();
			this.requestRender();
			return true;
		}
		const maxTop = Math.max(0, this.previousLines.length - this.terminal.rows);
		if (maxTop === 0) {
			if (this.isViewportHeld()) this.resumeViewport();
			return true;
		}
		const base = this.isViewportHeld() ? this.previousViewportTop : maxTop;
		const next = Math.max(0, Math.min(maxTop, base + delta * WHEEL_SCROLL_LINES));
		this.logMouse("wheel", `delta=${delta} base=${base} next=${next} maxTop=${maxTop}`);
		if (next >= maxTop) {
			// At (or back to) the latest content: resume live follow.
			if (!this.isViewportHeld()) return true;
			this.resumeViewport();
			return true;
		}
		this.cancelSelectionGestureForRerender();
		this.readingViewport = true;
		this.displayViewport(next);
		return true;
	}

	protected override consumeViewportKey(data: string): boolean {
		// Releases still reach raw listeners and opted-in components, but never act on the viewport.
		if (isKeyRelease(data)) return false;
		// Overlays own their keys.
		if (this.hasOverlay()) return false;
		// Explicit copy of the active transcript selection (Cmd+C where the
		// terminal forwards it). Plain Ctrl+C is interrupt and is never hijacked.
		if (matchesKey(data, "super+c") && this.getOrderedSelection()) {
			this.copySelectionToClipboard();
			if (this.pendingDrag) {
				// Treat explicit copy as completion when the terminal lost release:
				// retain the copied highlight but end the transient render hold.
				this.pendingDrag = undefined;
				this.lastClick = undefined;
				this.requestRender();
			}
			return true;
		}
		const kb = getKeybindings();
		const isPageUp = kb.matches(data, "tui.editor.pageUp");
		const isPageDown = kb.matches(data, "tui.editor.pageDown");
		if (!this.isViewportHeld()) {
			// PageUp enters reading mode only when older rows exist to read;
			// otherwise the editor keeps its paging behavior.
			if (isPageUp && this.previousLines.length > this.terminal.rows) {
				this.pageViewport(-1);
				return true;
			}
			return false;
		}
		if (isPageUp) {
			this.pageViewport(-1);
			return true;
		}
		if (isPageDown) {
			this.pageViewport(1);
			return true;
		}
		// Any other key resumes live follow; the key still acts normally.
		// resumeViewport() also supersedes any in-progress drag.
		this.resumeViewport();
		return false;
	}

	/**
	 * Leave a held viewport and repaint the latest content. A pure diff cannot
	 * do this: frozen bookkeeping matches the stale screen, so nothing would
	 * look changed. Snapping repaints first, then the follow-up render is a
	 * no-op diff plus cursor positioning.
	 */
	private isViewportHeld(): boolean {
		return this.readingViewport || this.pendingDrag !== undefined;
	}

	private resumeViewport(): void {
		if (!this.isViewportHeld()) return;
		this.logMouse("resume");
		this.cancelSelectionGestureForRerender();
		this.readingViewport = false;
		this.displayViewport(Math.max(0, this.previousLines.length - this.terminal.rows));
		this.requestRender();
	}

	private pageViewport(direction: -1 | 1): void {
		const height = this.terminal.rows;
		const maxTop = Math.max(0, this.previousLines.length - height);
		if (maxTop === 0) {
			if (this.isViewportHeld()) this.resumeViewport();
			return;
		}
		const step = direction * Math.max(1, height - 1);
		const base = this.isViewportHeld() ? this.previousViewportTop : maxTop;
		const next = Math.max(0, Math.min(maxTop, base + step));
		if (next >= maxTop) {
			this.resumeViewport();
			return;
		}
		this.cancelSelectionGestureForRerender();
		this.readingViewport = true;
		this.displayViewport(next);
	}

	/**
	 * Repaint the visible viewport with older rows while held. Anchors to the
	 * screen top (moving up clamps there) and writes exactly one viewport of
	 * rows with no trailing newline, so the terminal never scrolls. Only the
	 * viewport bookkeeping moves; content bookkeeping stays frozen.
	 */
	private displayViewport(top: number): void {
		const height = this.terminal.rows;
		const maxTop = Math.max(0, this.previousLines.length - height);
		const clamped = Math.max(0, Math.min(maxTop, top));
		if (clamped === this.previousViewportTop) return;
		this.logMouse("displayViewport", `top=${clamped}`);
		const cursorScreenRow = this.hardwareCursorRow - this.previousViewportTop;
		if (cursorScreenRow < 0 || cursorScreenRow >= height) {
			// Inconsistent cursor tracking: bail out to live follow instead of
			// painting from a wrong origin.
			this.readingViewport = false;
			this.cancelSelectionGestureForRerender();
			this.requestRender();
			return;
		}
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h");
		if (cursorScreenRow > 0) output.append(`\x1b[${cursorScreenRow}A`);
		output.append("\r");
		const renderEnd = Math.min(clamped + height, this.previousLines.length);
		for (let i = clamped; i < renderEnd; i++) {
			if (i > clamped) output.append("\r\n");
			output.append(this.withSelectionHighlight(this.previousLines[i] ?? "", i));
			output.append("\x1b[K");
		}
		output.append("\x1b[?2026l");
		output.flush();
		this.previousViewportTop = clamped;
		this.hardwareCursorRow = Math.max(clamped, renderEnd - 1);
		this.selectionRepaintStartRow = undefined;
		this.selectionRepaintEndRow = undefined;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		// Input and viewport holds cannot span a stop/start boundary.
		this.cancelSelectionGestureForRerender();
		this.readingViewport = false;
		this.pendingSelectionCopy = undefined;
		this.selectionCopyGeneration += 1;
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private applyLineResetsWithCache(rawLines: string[]): {
		lines: string[];
		firstChanged: number;
		lastChanged: number;
	} {
		const lines = new Array<string>(rawLines.length);
		let firstChanged = -1;
		let lastChanged = -1;
		for (let index = 0; index < rawLines.length; index++) {
			const rawLine = rawLines[index]!;
			if (rawLine === this.previousRawLines[index] && this.previousLines[index] !== undefined) {
				lines[index] = this.previousLines[index]!;
			} else {
				lines[index] = isImageLine(rawLine) ? rawLine : normalizeTerminalOutput(rawLine) + LINE_RESET;
			}
			if (lines[index] !== this.previousLines[index]) {
				if (firstChanged === -1) firstChanged = index;
				lastChanged = index;
			}
		}
		if (this.previousLines.length > rawLines.length) {
			if (firstChanged === -1) firstChanged = rawLines.length;
			lastChanged = this.previousLines.length - 1;
		}
		return { lines, firstChanged, lastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const geometryInvalidated = this.terminalGeometryInvalidated;
		this.terminalGeometryInvalidated = false;
		this.overlayFrameInvalidated = false;
		// Held viewports keep content bookkeeping frozen. Selection-only dirty
		// rows still paint through this throttled path, while resize and overlay
		// transitions terminate transient gestures and recover live rendering.
		if (this.isViewportHeld()) {
			if (
				geometryInvalidated ||
				this.terminal.columns !== this.previousWidth ||
				this.terminal.rows !== this.previousHeight
			) {
				// The coming full re-render repaints everything absolutely.
				this.readingViewport = false;
				this.cancelSelectionGestureForRerender();
			} else if (this.hasOverlay()) {
				this.resumeViewport();
			} else if (this.repaintSelectionRows()) {
				return;
			} else {
				// Invalid cursor bookkeeping is unsafe for a relative repaint.
				// Resume through the normal renderer, which recomputes geometry.
				this.readingViewport = false;
				this.cancelSelectionGestureForRerender();
			}
		}
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const liveTop = Math.max(0, this.previousLines.length - height);
		if (
			!geometryInvalidated &&
			width === this.previousWidth &&
			height === this.previousHeight &&
			this.previousViewportTop < liveTop
		) {
			// A lifecycle transition can end reading mode without changing any
			// content. Restore the physical viewport before the no-change diff.
			this.displayViewport(liveTop);
		}
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get raw lines.
		let newRawLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newRawLines = this.compositeOverlays(newRawLines, width, height);
		}

		// First frame with short content: pad with leading blank rows so the
		// frame is exactly viewport-height and content is bottom-anchored.
		// Otherwise short content inherits the cursor row in used terminals
		// while hit-testing assumes row 0, offsetting every click. Writing a
		// full viewport from any cursor row always lands bottom-anchored, so
		// the padding doubles as real screen rows from here on.
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged && newRawLines.length < height) {
			newRawLines = [...new Array<string>(height - newRawLines.length).fill(""), ...newRawLines];
		}

		// Extract cursor position before applying line resets (marker must be found first).
		const cursorPos = this.extractCursorPosition(newRawLines, height);
		const normalized = this.applyLineResetsWithCache(newRawLines);
		const newLines = normalized.lines;
		// Text selection highlight lives outside the line cache; the active
		// selection object is threaded through every write site below.

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			if (clear) {
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) output.append("\r\n");
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					output.append(line);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				output.append(this.withSelectionHighlight(line, i));
			}
			output.append("\x1b[?2026l"); // End synchronized output
			output.flush();
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = newRawLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.selectionRepaintStartRow = undefined;
			this.selectionRepaintEndRow = undefined;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			try {
				const logPath = path.join(this.logDirectory, "pi-debug.log");
				const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
				fs.mkdirSync(path.dirname(logPath), { recursive: true });
				fs.appendFileSync(logPath, msg);
			} catch {
				// Diagnostics must never break rendering.
			}
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// If the terminal resized away and back between frames, dimensions match
		// again but its physical contents and cursor may have reflowed twice.
		if (geometryInvalidated && !widthChanged && !heightChanged) {
			logRedraw("terminal geometry changed between frames");
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// The normalization pass already records exact changed rows, avoiding a second full transcript scan.
		let firstChanged = normalized.firstChanged;
		let lastChanged = normalized.lastChanged;
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		const selectionRepaintStart = this.selectionRepaintStartRow;
		const selectionRepaintEnd = this.selectionRepaintEndRow;
		this.selectionRepaintStartRow = undefined;
		this.selectionRepaintEndRow = undefined;
		if (selectionRepaintStart !== undefined && selectionRepaintEnd !== undefined && newLines.length > 0) {
			const repaintStart = Math.max(0, Math.min(newLines.length - 1, selectionRepaintStart));
			const repaintEnd = Math.max(repaintStart, Math.min(newLines.length - 1, selectionRepaintEnd));
			firstChanged = firstChanged === -1 ? repaintStart : Math.min(firstChanged, repaintStart);
			lastChanged = Math.max(lastChanged, repaintEnd);
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const activeSelection = this.getOrderedSelection();
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousRawLines = newRawLines;
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					output.append(`\x1b[${clearStartOffset}B`);
				}
				for (let i = 0; i < extraLines; i++) {
					output.append("\r\x1b[2K");
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					output.append(`\x1b[${moveBack}A`);
				}
				output.append("\x1b[?2026l");
				output.flush();
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = newRawLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// A change above the previous viewport (e.g. a tall streaming message
		// restyling its earlier lines) must never blank the screen: repaint the
		// visible window in place instead of clearing. A full clear flashes on
		// every such frame while the message streams and wipes scrollback.
		if (firstChanged < prevViewportTop) {
			if (newLines.some((line) => isImageLine(line)) || this.previousLines.some((line) => isImageLine(line))) {
				logRedraw(`firstChanged < viewportTop with images (${firstChanged} < ${prevViewportTop})`);
				fullRender(true);
				return;
			}
			logRedraw(`repaint viewport for above-viewport change (${firstChanged} < ${prevViewportTop})`);
			this.fullRedrawCount += 1;
			viewportTop = Math.max(0, newLines.length - height);
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			// Move to the first visible row. CUD/CUU never scroll, unlike "\r\n".
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			if (currentScreenRow > 0) output.append(`\x1b[${currentScreenRow}A`);
			else if (currentScreenRow < 0) output.append(`\x1b[${-currentScreenRow}B`);
			hardwareCursorRow = viewportTop;
			output.append("\r");
			const visibleEnd = Math.min(newLines.length, viewportTop + height);
			for (let i = viewportTop; i < visibleEnd; i++) {
				if (i > viewportTop) output.append("\x1b[1B\r");
				let line = newLines[i]!;
				let lineWidth = visibleWidth(line);
				if (lineWidth > width) {
					// Same guard as the differential path: a width disagreement must
					// never kill the session. Truncate, record, and fall through.
					try {
						const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
						const crashData = [
							`Truncated over-wide line at ${new Date().toISOString()}`,
							`Terminal width: ${width}`,
							`Line ${i} visible width: ${lineWidth}`,
							`Line content: ${line.slice(0, 500)}`,
							"",
						].join("\n");
						fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
						fs.appendFileSync(crashLogPath, `${crashData}\n`);
					} catch {
						// Diagnostics must never break rendering.
					}
					line = truncateToWidth(line, width);
					newLines[i] = line;
					lineWidth = visibleWidth(line);
				}
				output.append(this.withSelectionHighlight(line, i, activeSelection));
				if (lineWidth < width) output.append("\x1b[K");
			}
			// Clear rows left over when content is shorter than the viewport,
			// then return to the last content row.
			const leftoverRows = height - (visibleEnd - viewportTop);
			for (let i = 0; i < leftoverRows; i++) {
				output.append("\x1b[1B\r\x1b[2K");
			}
			if (leftoverRows > 0) output.append(`\x1b[${leftoverRows}A`);
			output.append("\x1b[?2026l"); // End synchronized output
			output.flush();
			const finalCursorRow = Math.max(viewportTop, visibleEnd - 1);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = finalCursorRow;
			this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			this.previousViewportTop = viewportTop;
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = newRawLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			return;
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // Move down
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			let line = newLines[i]!;
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			let lineWidth = isImage ? 0 : visibleWidth(line);
			if (!isImage && lineWidth > width) {
				// An over-wide line must never kill the session: a 1-column
				// width disagreement (new emoji, custom component bug) would
				// otherwise crash the agent mid-run. Truncate, record, and
				// fall through to the normal write path below.
				try {
					const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
					const crashData = [
						`Truncated over-wide line at ${new Date().toISOString()}`,
						`Terminal width: ${width}`,
						`Line ${i} visible width: ${lineWidth}`,
						`Line content: ${line.slice(0, 500)}`,
						"",
					].join("\n");
					fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
					fs.appendFileSync(crashLogPath, `${crashData}\n`);
				} catch {
					// Diagnostics must never break rendering.
				}
				line = truncateToWidth(line, width);
				newLines[i] = line;
				lineWidth = visibleWidth(line);
			}
			if (isImage) {
				output.append("\x1b[2K");
				output.append(line);
			} else {
				output.append(this.withSelectionHighlight(line, i, activeSelection));
				if (lineWidth < width) output.append("\x1b[K");
			}
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			output.append(`\x1b[${extraLines}A`);
		}

		output.append("\x1b[?2026l"); // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			try {
				const debugDir = "/tmp/tui";
				fs.mkdirSync(debugDir, { recursive: true });
				const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
				const debugData = [
					`firstChanged: ${firstChanged}`,
					`viewportTop: ${viewportTop}`,
					`cursorRow: ${this.cursorRow}`,
					`height: ${height}`,
					`lineDiff: ${lineDiff}`,
					`hardwareCursorRow: ${hardwareCursorRow}`,
					`renderEnd: ${renderEnd}`,
					`finalCursorRow: ${finalCursorRow}`,
					`cursorPos: ${JSON.stringify(cursorPos)}`,
					`newLines.length: ${newLines.length}`,
					`previousLines.length: ${this.previousLines.length}`,
					"",
					"=== newLines ===",
					JSON.stringify(newLines, null, 2),
					"",
					"=== previousLines ===",
					JSON.stringify(this.previousLines, null, 2),
					"",
					"=== buffer ===",
					`[${output.length} chars written in bounded chunks]`,
				].join("\n");
				fs.writeFileSync(debugPath, debugData);
			} catch {
				// Diagnostics must never break rendering.
			}
		}

		output.flush();

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousRawLines = newRawLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed, clamped to the last column so a
		// cursor past end-of-line never wraps onto the next row).
		buffer += `\x1b[${Math.min(this.terminal.columns, targetCol + 1)}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
