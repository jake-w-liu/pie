/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Decode file bytes for editing. The edited file is written back as UTF-8, so bytes that do not
 * survive a UTF-8 round trip (for example a Latin-1 "é") would turn into U+FFFD everywhere in the
 * file, not just in the edited region. Such files are refused instead.
 */
export function decodeEditableText(buffer: Buffer, path: string): string {
	const text = buffer.toString("utf-8");
	if (!Buffer.from(text, "utf-8").equals(buffer)) {
		throw new Error(
			`Cannot edit ${path}: the file is not valid UTF-8, and rewriting it would corrupt its non-UTF-8 bytes.`,
		);
	}
	return text;
}

/** Collapse leading indentation to one space and strip trailing whitespace. */
function normalizeFuzzyLine(line: string): string {
	return line.replace(/^[ \t]+/, " ").trimEnd();
}

/** One-to-one character substitutions, so they never change offsets. */
function replaceFuzzyCharacters(text: string): string {
	return (
		text
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Collapse leading indentation runs to a single space (tabs vs spaces)
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return replaceFuzzyCharacters(text.normalize("NFKC").split("\n").map(normalizeFuzzyLine).join("\n"));
}

/**
 * Fuzzy-normalized content with, for each of its UTF-16 code units, the `[start, end)` range of
 * the source it came from. A collapsed indentation run maps to the whole run, and every unit of
 * a grapheme changed by NFKC maps to that whole grapheme.
 */
interface FuzzySourceMap {
	text: string;
	starts: number[];
	ends: number[];
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * NFKC-normalize one line. When normalization changes it, also return each output unit's source
 * range relative to the line start; `undefined` ranges mean the text is unchanged.
 */
function normalizeLineNfkc(line: string): { text: string; starts?: number[]; ends?: number[] } {
	const text = line.normalize("NFKC");
	if (text === line) return { text };
	const pieces: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	for (const { segment, index } of graphemeSegmenter.segment(line)) {
		const normalized = segment.normalize("NFKC");
		const unchanged = normalized === segment;
		pieces.push(normalized);
		for (let offset = 0; offset < normalized.length; offset++) {
			starts.push(unchanged ? index + offset : index);
			ends.push(unchanged ? index + offset + 1 : index + segment.length);
		}
	}
	// Normalizing grapheme by grapheme matches normalizing the whole line in practice. Refuse rather
	// than map offsets through text that differs from what the old text is matched against.
	if (pieces.join("") !== text) {
		throw new Error(
			"Cannot map a fuzzy match back to the file content. Use the exact text from the file as oldText.",
		);
	}
	return { text, starts, ends };
}

/** Build the same text as `normalizeForFuzzyMatch(content)`, tracking where each unit came from. */
function buildFuzzySourceMap(content: string): FuzzySourceMap {
	const pieces: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	for (let lineStart = 0; ; ) {
		const newline = content.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? content.length : newline;
		const line = normalizeLineNfkc(content.slice(lineStart, lineEnd));
		const lineStarts = line.starts;
		const lineEnds = line.ends;
		const indentLength = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
		const keptLength = normalizeFuzzyLine(line.text).length;
		if (keptLength > 0) {
			// The kept text is the collapsed indentation (one space for the whole run) followed by the
			// rest of the line up to its trailing whitespace.
			let from = 0;
			let to = keptLength;
			if (indentLength > 0) {
				pieces.push(" ");
				starts.push(lineStart + (lineStarts ? lineStarts[0] : 0));
				ends.push(lineStart + (lineEnds ? lineEnds[indentLength - 1] : indentLength));
				from = indentLength;
				to = indentLength + keptLength - 1;
			}
			pieces.push(line.text.slice(from, to));
			for (let offset = from; offset < to; offset++) {
				starts.push(lineStart + (lineStarts ? lineStarts[offset] : offset));
				ends.push(lineStart + (lineEnds ? lineEnds[offset] : offset + 1));
			}
		}
		if (newline === -1) break;
		pieces.push("\n");
		starts.push(newline);
		ends.push(newline + 1);
		lineStart = newline + 1;
	}
	return { text: replaceFuzzyCharacters(pieces.join("")), starts, ends };
}

function leadingIndent(line: string): string {
	return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

/**
 * Fuzzy matching ignores indentation style, so `oldText` can be indented differently from the lines
 * it matched (for example four spaces where the file uses a tab). Re-indent `newText` to the file's
 * style: a new line indented like an old line takes the file's indentation for that old line, and a
 * deeper line keeps its extra indentation on top of the closest such level. When `oldText` already
 * used the file's indentation, `newText` is returned unchanged so intended re-indents survive.
 */
function reindentFuzzyReplacement(
	content: string,
	start: number,
	end: number,
	oldText: string,
	newText: string,
): string {
	const oldLines = oldText.split("\n");
	const fileLines = content.slice(start, end).split("\n");
	// Leading whitespace of a first line that starts mid-line is not indentation.
	const firstFullLine = start === 0 || content[start - 1] === "\n" ? 0 : 1;

	const pairs: Array<{ oldIndent: string; fileIndent: string } | undefined> = [];
	let indentationDiffers = false;
	for (let index = firstFullLine; index < Math.min(oldLines.length, fileLines.length); index++) {
		if (isBlank(oldLines[index]) || isBlank(fileLines[index])) continue;
		const pair = { oldIndent: leadingIndent(oldLines[index]), fileIndent: leadingIndent(fileLines[index]) };
		pairs[index] = pair;
		if (pair.oldIndent !== pair.fileIndent) indentationDiffers = true;
	}
	if (!indentationDiffers) return newText;

	// Old indentation -> file indentation, or null when the file used more than one for it.
	const indentMap = new Map<string, string | null>();
	for (const pair of pairs) {
		if (!pair) continue;
		const known = indentMap.get(pair.oldIndent);
		indentMap.set(pair.oldIndent, known === undefined || known === pair.fileIndent ? pair.fileIndent : null);
	}

	const newLines = newText.split("\n");
	// Line-for-line edits can use the old line at the same position, which also resolves an old
	// indentation the file used in more than one way.
	const sameShape = newLines.length === oldLines.length;
	return newLines
		.map((line, index) => {
			if (index < firstFullLine || isBlank(line)) return line;
			const indent = leadingIndent(line);
			const body = line.slice(indent.length);
			const pair = sameShape ? pairs[index] : undefined;
			if (pair && pair.oldIndent === indent) return pair.fileIndent + body;
			const mapped = indentMap.get(indent);
			if (typeof mapped === "string") return mapped + body;
			let closest: string | undefined;
			for (const [oldIndent, fileIndent] of indentMap) {
				if (fileIndent === null || !indent.startsWith(oldIndent)) continue;
				if (closest === undefined || oldIndent.length > closest.length) closest = oldIndent;
			}
			if (closest === undefined) return line;
			return `${indentMap.get(closest)}${indent.slice(closest.length)}${body}`;
		})
		.join("\n");
}

/** A replacement in LF-normalized content: `[start, end)` becomes `text`, which uses LF line endings. */
export interface EditReplacement {
	start: number;
	end: number;
	text: string;
}

interface MatchedEdit extends EditReplacement {
	editIndex: number;
}

function applyReplacements(content: string, replacements: readonly EditReplacement[]): string {
	const pieces: string[] = [];
	let cursor = 0;
	for (const replacement of replacements) {
		pieces.push(content.slice(cursor, replacement.start), replacement.text);
		cursor = replacement.end;
	}
	pieces.push(content.slice(cursor));
	return pieces.join("");
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	/** The applied replacements in `baseContent` offsets, sorted and non-overlapping. */
	replacements: EditReplacement[];
}

/**
 * Give a replacement's line breaks their final form. A line-for-line replacement reuses the line
 * breaks of the text it replaces, so each line of a mixed-ending file keeps its ending; otherwise
 * every break uses the file's line ending.
 */
function restoreReplacementLineEndings(text: string, replacedText: string, lineEnding: "\r\n" | "\n"): string {
	const lines = text.split("\n");
	const replacedBreaks = replacedText.match(/\r\n|\r|\n/g) ?? [];
	if (lines.length === 1 || replacedBreaks.length !== lines.length - 1) return restoreLineEndings(text, lineEnding);
	let result = lines[0];
	for (let index = 1; index < lines.length; index++) {
		result += replacedBreaks[index - 1] + lines[index];
	}
	return result;
}

/**
 * Apply replacements computed against the LF-normalized form of `originalContent` to the original
 * text. Only the replaced ranges change, so CRLF, lone CR, and mixed line endings elsewhere keep
 * their bytes.
 */
export function applyReplacementsToOriginal(
	originalContent: string,
	replacements: readonly EditReplacement[],
	lineEnding: "\r\n" | "\n",
): string {
	const hasCarriageReturn = originalContent.includes("\r");
	let rawOffset = 0;
	let normalizedOffset = 0;
	// Replacements are sorted, so one forward walk maps every offset: "\r\n" and a lone "\r" are
	// each one normalized character.
	const toRawOffset = (offset: number): number => {
		if (!hasCarriageReturn) return offset;
		while (normalizedOffset < offset) {
			rawOffset +=
				originalContent.charCodeAt(rawOffset) === 13 && originalContent.charCodeAt(rawOffset + 1) === 10 ? 2 : 1;
			normalizedOffset++;
		}
		return rawOffset;
	};
	const pieces: string[] = [];
	let cursor = 0;
	for (const replacement of replacements) {
		const start = toRawOffset(replacement.start);
		const end = toRawOffset(replacement.end);
		pieces.push(
			originalContent.slice(cursor, start),
			restoreReplacementLineEndings(replacement.text, originalContent.slice(start, end), lineEnding),
		);
		cursor = end;
	}
	pieces.push(originalContent.slice(cursor));
	return pieces.join("");
}

/** Count occurrences, including overlapping ones: a pattern that repeats inside its own match is ambiguous. */
function countOccurrences(content: string, pattern: string, firstIndex: number): number {
	let count = 0;
	for (let index = firstIndex; index !== -1; index = content.indexOf(pattern, index + 1)) {
		count++;
	}
	return count;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	const hint =
		"The old text was not found exactly or after whitespace/quote normalization. Check indentation, spelling, and line endings.";
	if (totalEdits === 1) {
		return new Error(`Could not find the text in ${path}. ${hint}`);
	}
	return new Error(`Could not find edits[${editIndex}] in ${path}. ${hint}`);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. An edit whose old text occurs exactly
 * is matched exactly and must be unique as written. Otherwise it is matched after fuzzy
 * normalization (indentation, trailing whitespace, quotes, dashes, special spaces) and the match is
 * mapped back to the source, so only the matched characters are replaced and every other character
 * keeps its original form.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	let fuzzyContent: FuzzySourceMap | undefined;
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const { oldText, newText } = normalizedEdits[i];
		const exactIndex = normalizedContent.indexOf(oldText);
		if (exactIndex !== -1) {
			const occurrences = countOccurrences(normalizedContent, oldText, exactIndex);
			if (occurrences > 1) {
				throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
			}
			matchedEdits.push({ editIndex: i, start: exactIndex, end: exactIndex + oldText.length, text: newText });
			continue;
		}

		fuzzyContent ??= buildFuzzySourceMap(normalizedContent);
		const fuzzyOldText = normalizeForFuzzyMatch(oldText);
		// Whitespace-only old text normalizes to an empty pattern, which "matches" at offset 0
		// without anchoring to any character. Report it as not found instead of editing there.
		const fuzzyIndex = fuzzyOldText.length === 0 ? -1 : fuzzyContent.text.indexOf(fuzzyOldText);
		if (fuzzyIndex === -1) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}
		const occurrences = countOccurrences(fuzzyContent.text, fuzzyOldText, fuzzyIndex);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}
		const { starts, ends } = fuzzyContent;
		const fuzzyEnd = fuzzyIndex + fuzzyOldText.length;
		// A match that starts or ends inside the normalized form of one source character (the "2" of
		// "½" -> "1⁄2") would replace the rest of that character too, so it does not count as found.
		if (
			(fuzzyIndex > 0 && starts[fuzzyIndex - 1] === starts[fuzzyIndex]) ||
			(fuzzyEnd < ends.length && ends[fuzzyEnd] === ends[fuzzyEnd - 1])
		) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}
		const start = starts[fuzzyIndex];
		const end = ends[fuzzyEnd - 1];
		matchedEdits.push({
			editIndex: i,
			start,
			end,
			text: reindentFuzzyReplacement(normalizedContent, start, end, oldText, newText),
		});
	}

	matchedEdits.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.end > current.start) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const replacements = matchedEdits.map(({ start, end, text }) => ({ start, end, text }));
	const newContent = applyReplacements(normalizedContent, replacements);
	if (newContent === normalizedContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent: normalizedContent, newContent, replacements };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file. The preview refuses the same non-UTF-8 files the edit itself refuses.
		const rawContent = decodeEditableText(await readFile(absolutePath), path);

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
