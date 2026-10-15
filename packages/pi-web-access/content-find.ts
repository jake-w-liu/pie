export type FindMode = "exact" | "case-insensitive" | "fuzzy";

const CONTEXT_CHARS = 400;
const MAX_OUTPUT_CHARS = 20_000;

interface Match {
	query: string;
	start: number;
	end: number;
}

interface Range {
	start: number;
	end: number;
	matches: Match[];
}

function splitsSurrogatePair(text: string, offset: number): boolean {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function normalize(value: string): string {
	return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function editDistanceWithin(left: string, right: string, maximum: number): boolean {
	if (Math.abs(left.length - right.length) > maximum) return false;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		let rowMinimum = i;
		for (let j = 1; j <= right.length; j++) {
			const value = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
			current[j] = value;
			rowMinimum = Math.min(rowMinimum, value);
		}
		if (rowMinimum > maximum) return false;
		previous = current;
	}
	return (previous[right.length] ?? maximum + 1) <= maximum;
}

/**
 * Case-fold `text` for a case-insensitive search while keeping a map from every folded
 * UTF-16 index back to the original one.
 *
 * Folding the whole string at once (`text.toLowerCase()`) changes its length:
 * `"İ".toLowerCase()` is two code units, so a folded offset no longer points at
 * the same place in the original text and slicing the original with it returned
 * unrelated snippets. Folding per code point keeps `map` exact.
 */
interface FoldedText {
	folded: string;
	starts: number[] | null;
	ends: number[] | null;
}

function foldWithOffsets(text: string): FoldedText {
	// Fast path: one native call instead of ~1 µs of work per code point. Lowercasing
	// only grows code points (İ), so an unchanged total length means no offset moved.
	// toLowerCase() ignores the host locale: under Turkish or Azeri, toLocaleLowerCase()
	// folds "I" to dotless "ı" in some strings, so text and query could fold apart.
	const wholeFolded = text.toLowerCase().replace(/ς/g, "σ");
	if (wholeFolded.length === text.length) return { folded: wholeFolded, starts: null, ends: null };
	let folded = "";
	let starts: number[] | null = null;
	let ends: number[] | null = null;
	let originalIndex = 0;
	for (const char of text) {
		// Final and ordinary sigma have the same case-insensitive identity.
		const lowered = char.toLowerCase().replace(/ς/g, "σ");
		if (lowered.length !== char.length && starts === null) {
			starts = Array.from({ length: folded.length }, (_, index) => index);
			ends = Array.from({ length: folded.length }, (_, index) => index + 1);
		}
		if (starts && ends) {
			for (let unit = 0; unit < lowered.length; unit++) {
				starts.push(originalIndex);
				ends.push(originalIndex + char.length);
			}
		}
		folded += lowered;
		originalIndex += char.length;
	}
	return { folded, starts, ends };
}

function literalMatches(text: string, query: string, caseInsensitive: boolean, foldedText?: FoldedText): Match[] {
	if (caseInsensitive) {
		const { folded, starts, ends } = foldedText ?? foldWithOffsets(text);
		const needle = foldWithOffsets(query).folded;
		const matches: Match[] = [];
		for (let start = folded.indexOf(needle); start >= 0; start = folded.indexOf(needle, start + Math.max(needle.length, 1))) {
			matches.push({
				query,
				start: starts?.[start] ?? start,
				end: ends?.[start + needle.length - 1] ?? start + needle.length,
			});
		}
		return matches;
	}
	const haystack = text;
	const needle = query;
	const matches: Match[] = [];
	for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + Math.max(needle.length, 1))) {
		matches.push({ query, start, end: start + query.length });
	}
	return matches;
}

function fuzzyMatches(text: string, query: string): Match[] {
	const queryTokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
	if (queryTokens.length === 0) return [];
	const matches: Match[] = [];
	// Paragraphs are runs of non-blank lines. CRLF/CR breaks and whitespace-only lines
	// separate them too; `\n(?!\n)` saw the CR of "\r\n\r\n" and merged paragraphs.
	const paragraphs = /\S[^\r\n]*(?:(?:\r\n?|\n)[^\S\r\n]*\S[^\r\n]*)*/g;
	for (const paragraph of text.matchAll(paragraphs)) {
		const paragraphText = paragraph[0];
		if (paragraph.index === undefined) continue;
		const tokens = [...paragraphText.matchAll(/[\p{L}\p{N}]+/gu)];
		const matched = queryTokens.filter(queryToken => tokens.some(token => {
			const candidate = normalize(token[0]);
			const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
			return editDistanceWithin(queryToken, candidate, maximum);
		}));
		const required = queryTokens.length === 1 ? 1 : Math.ceil(queryTokens.length * 0.6);
		if (matched.length < required) continue;
		const first = tokens.find(token => matched.some(queryToken => {
			const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
			return editDistanceWithin(queryToken, normalize(token[0]), maximum);
		}));
		const start = paragraph.index + (first?.index ?? 0);
		matches.push({ query, start, end: start + (first?.[0].length ?? query.length) });
	}
	return matches;
}

function mergeRanges(textLength: number, matches: Match[]): Range[] {
	const ranges: Range[] = [];
	for (const match of [...matches].sort((left, right) => left.start - right.start)) {
		const start = Math.max(0, match.start - CONTEXT_CHARS);
		const end = Math.min(textLength, match.end + CONTEXT_CHARS);
		const previous = ranges.at(-1);
		if (previous && start <= previous.end) {
			previous.end = Math.max(previous.end, end);
			previous.matches.push(match);
		} else {
			ranges.push({ start, end, matches: [match] });
		}
	}
	return ranges;
}

export function findContent(
	text: string,
	queries: string[],
	mode: FindMode,
): { text: string; matchCount: number; returnedMatches: number; queryResults: Array<{ query: string; matchCount: number }> } {
	const normalizedQueries = [...new Set(queries.map(query => query.trim()).filter(Boolean))];
	const foldedText = mode === "case-insensitive" ? foldWithOffsets(text) : undefined;
	const matches = normalizedQueries.flatMap(query => mode === "fuzzy"
		? fuzzyMatches(text, query)
		: literalMatches(text, query, mode === "case-insensitive", foldedText));
	const queryResults = normalizedQueries.map(query => ({
		query,
		matchCount: matches.filter(match => match.query === query).length,
	}));

	const heading = matches.length > 0 ? `Text matches (${mode})` : `Text matches (${mode}): no matches`;
	const sections = [heading];
	let formattedLength = heading.length;
	let returnedMatches = 0;
	// Reserve the longest possible truncation footer before admitting excerpts.
	const footerReserve = matches.length > 0 ? 2 + `Showing ${matches.length} of ${matches.length} matches.`.length : 0;
	for (const range of mergeRanges(text.length, matches)) {
		// Expand natural context edges to whole scalars before applying the budget.
		const start = range.start - (splitsSurrogatePair(text, range.start) ? 1 : 0);
		const contextEnd = range.end + (splitsSurrogatePair(text, range.end) ? 1 : 0);
		const fullCounts = [...new Set(range.matches.map(match => match.query))]
			.map(query => `\"${query}\" ×${range.matches.filter(match => match.query === query).length}`)
			.join(", ");
		const maxSnippetChars = MAX_OUTPUT_CHARS - formattedLength - 2 - `${sections.length}. ${fullCounts}\n`.length - 2 - footerReserve;
		if (maxSnippetChars <= 0) break;
		let end = Math.min(contextEnd, start + maxSnippetChars);
		// A budget crop must also stay between scalars; never repair the text itself.
		if (splitsSurrogatePair(text, end)) end--;
		const represented = range.matches.filter(match => match.start >= start && match.end <= end);
		if (represented.length === 0) continue;
		const prefix = start > 0 ? "…" : "";
		const suffix = end < text.length ? "…" : "";
		const snippet = `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
		const counts = [...new Set(represented.map(match => match.query))]
			.map(query => `\"${query}\" ×${represented.filter(match => match.query === query).length}`)
			.join(", ");
		const section = `${sections.length}. ${counts}\n${snippet}`;
		sections.push(section);
		formattedLength += 2 + section.length;
		returnedMatches += represented.length;
	}

	const missing = queryResults.filter(result => result.matchCount === 0).map(result => `\"${result.query}\"`);
	const footer = [
		...(returnedMatches < matches.length ? [`Showing ${returnedMatches} of ${matches.length} matches.`] : []),
		...(missing.length > 0 ? [`No matches: ${missing.join(", ")}`] : []),
	];
	for (const section of footer) {
		if (formattedLength + 2 + section.length > MAX_OUTPUT_CHARS) break;
		sections.push(section);
		formattedLength += 2 + section.length;
	}

	return { text: sections.join("\n\n"), matchCount: matches.length, returnedMatches, queryResults };
}
