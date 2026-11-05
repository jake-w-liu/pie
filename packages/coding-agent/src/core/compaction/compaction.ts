/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import {
	addUsage,
	CONCISE_RETRY_NOTE,
	type SummarizationRequestOptions,
	type SummaryInstructionContext,
	summarizeTranscript,
	summaryHardLimitTokens,
	summaryLengthRule,
	summaryTargetTokens,
} from "./summarization.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
} from "./utils.ts";

export {
	completeSummarization,
	getSummarizationFailure,
	type SummarizationRequestOptions,
	summaryHardLimitTokens,
	summaryTargetTokens,
} from "./summarization.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
	/** Individual request usage is already persisted separately by AgentSession. */
	usageRecorded?: boolean;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Preserve structured file tracking even when summary prose omits filenames.
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "branch_summary" && (entry.type !== "compaction" || i !== prevCompactionIndex)) continue;
		if (!entry.fromHook && entry.details) {
			const details = entry.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) if (typeof f === "string") fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) if (typeof f === "string") fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return sessionEntryToContextMessages(entry)[0];
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.87;

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Settings come from user JSON files; replace non-numeric or negative token counts with defaults. */
function normalizeTokenSetting(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeCompactionSettings(settings: CompactionSettings): CompactionSettings {
	return {
		enabled: settings.enabled !== false,
		reserveTokens: normalizeTokenSetting(settings.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
		keepRecentTokens: normalizeTokenSetting(settings.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
	};
}

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

/** Latest valid usage that was reported after the newest compaction checkpoint in `messages`. */
function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	let checkpointTimestamp = Number.NEGATIVE_INFINITY;
	for (const message of messages) {
		if (message.role === "compactionSummary") checkpointTimestamp = Math.max(checkpointTimestamp, message.timestamp);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const usage = getAssistantUsage(message);
		if (usage && message.timestamp > checkpointTimestamp) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Upper bound for scaling message estimates up to match provider-reported prompt size. */
const MAX_ESTIMATE_SCALE = 10;

/**
 * Factor by which chars/4 message estimates undercount the provider's real prompt size.
 *
 * The latest valid usage reports the prompt tokens of the request that produced it. When the
 * estimate of that same prompt is lower, for example because replayed encrypted reasoning or
 * dense code is invisible to a character count, cut-point accounting scales every message by
 * the measured ratio so the retained recent messages really fit their budget. Estimates are
 * never scaled down: overestimating retains less, which is the safe direction.
 */
function estimateTokenScale(messages: AgentMessage[], prefixTokens: number): number {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (!usageInfo) return 1;
	const { usage } = usageInfo;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!Number.isFinite(promptTokens) || promptTokens <= 0) return 1;
	let estimatedPrompt = Number.isFinite(prefixTokens) ? Math.max(0, prefixTokens) : 0;
	for (let i = 0; i < usageInfo.index; i++) estimatedPrompt += estimateTokens(messages[i]);
	if (estimatedPrompt <= 0 || promptTokens <= estimatedPrompt) return 1;
	return Math.min(MAX_ESTIMATE_SCALE, promptTokens / estimatedPrompt);
}

/**
 * Check if compaction should trigger based on context usage.
 *
 * The ratio boundary prevents large-context models from waiting until nearly
 * full, while the reserve boundary remains authoritative when it is stricter.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (settings.enabled === false || !Number.isFinite(contextWindow) || contextWindow <= 0 || !(contextTokens > 0)) {
		return false;
	}

	return contextTokens >= compactionThreshold(contextWindow, settings);
}

/** Context size, in tokens, at which automatic compaction starts. */
export function compactionThreshold(contextWindow: number, settings: CompactionSettings): number {
	const normalized = normalizeCompactionSettings(settings);
	return Math.max(
		1,
		Math.min(
			Math.floor(contextWindow * DEFAULT_COMPACTION_TRIGGER_RATIO),
			contextWindow - effectiveReserveTokens(contextWindow, normalized.reserveTokens),
		),
	);
}

/**
 * The reserve is an absolute token count, and the default equals a whole 16k window. Cap it at
 * half the window so small-context models keep room for history below the trigger, and branch
 * summaries keep an input budget. Windows of at least twice the reserve are unaffected.
 */
export function effectiveReserveTokens(contextWindow: number, reserveTokens: number): number {
	const reserve = Number.isFinite(reserveTokens) ? Math.max(0, reserveTokens) : 0;
	return Number.isFinite(contextWindow) && contextWindow > 0
		? Math.min(reserve, Math.floor(contextWindow / 2))
		: reserve;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * Length of a persisted text field. Session files and extension results are not validated
 * at runtime, and a malformed field must not make every context check throw.
 */
function textLength(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
}

function estimateTextAndImageContentChars(content: unknown): number {
	if (typeof content === "string") {
		return content.length;
	}
	if (!Array.isArray(content)) return 0;

	let chars = 0;
	for (const block of content as Array<{ type?: unknown; text?: unknown } | null>) {
		if (block?.type === "text") {
			chars += textLength(block.text);
		} else if (block?.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of Array.isArray(assistant.content) ? assistant.content : []) {
				if (block?.type === "text") {
					chars += textLength(block.text);
				} else if (block?.type === "thinking") {
					chars += textLength(block.thinking);
				} else if (block?.type === "toolCall") {
					chars += textLength(block.name) + textLength(JSON.stringify(block.arguments ?? {}));
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = textLength(message.command) + textLength(message.output);
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = textLength(message.summary);
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

export interface CutPointOptions {
	/**
	 * Upper bound for retained tokens. When the entry that crosses `keepRecentTokens` would
	 * push retention above it, the cut moves to the earliest later cut point that fits, or to
	 * the latest cut point when none does.
	 */
	maxKeepTokens?: number;
	/** Multiplier for per-message estimates, calibrated from provider usage. Values below 1 are ignored. */
	tokenScale?: number;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
	options: CutPointOptions = {},
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	const scale =
		options.tokenScale !== undefined && Number.isFinite(options.tokenScale) && options.tokenScale > 1
			? options.tokenScale
			: 1;
	// keptTokens[i - startIndex] is the estimated size of entries i..endIndex-1.
	const keptTokens = new Array<number>(endIndex - startIndex + 1).fill(0);
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entryTokens =
			sessionEntryToContextMessages(entries[i]).reduce((sum, message) => sum + estimateTokens(message), 0) * scale;
		keptTokens[i - startIndex] = keptTokens[i - startIndex + 1] + entryTokens;
	}
	const keptFrom = (index: number): number => keptTokens[index - startIndex];

	// Walk backwards from newest, accumulating estimated message sizes
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		if (keptFrom(i) === keptFrom(i + 1)) continue;

		// Check if we've exceeded the budget
		if (keptFrom(i) >= keepRecentTokens) {
			// Prefer the closest valid cut point at or after this entry. When the
			// budget is crossed by a trailing tool result, keep its preceding
			// assistant tool call too so the pair remains valid.
			let foundCutPoint = false;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					foundCutPoint = true;
					break;
				}
			}
			if (!foundCutPoint) {
				for (let c = cutPoints.length - 1; c >= 0; c--) {
					if (cutPoints[c] <= i) {
						cutIndex = cutPoints[c];
						break;
					}
				}
			}
			break;
		}
	}

	// A single large entry crossing the retention target must not keep the context near the
	// compaction threshold; move the cut later until retention fits the hard bound.
	const maxKeepTokens = options.maxKeepTokens;
	if (maxKeepTokens !== undefined && Number.isFinite(maxKeepTokens) && keptFrom(cutIndex) > maxKeepTokens) {
		const fittingCutPoint = cutPoints.find(
			(candidate) => candidate > cutIndex && keptFrom(candidate) <= maxKeepTokens,
		);
		cutIndex = fittingCutPoint ?? cutPoints[cutPoints.length - 1];
	}

	// Split-turn classification is based on the context-visible cut point. Metadata
	// retained immediately before it must not turn a clean user boundary into a split.
	const contextCutIndex = cutIndex;

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	// Determine if this is a split turn.
	const cutEntry = entries[contextCutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, contextCutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const CHECKPOINT_SECTIONS = `## Goal
- [What the user is trying to accomplish; quote exact wording where it matters]

## Constraints & Preferences
- [Requirements, preferences, and corrections from the user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks and changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Open problems, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, examples, references, or exact values needed to continue, or "(none)"]`;

interface InstructionOptions extends SummaryInstructionContext {
	targetTokens: number;
	customInstructions?: string;
}

function finishInstructions(parts: string[], options: InstructionOptions): string {
	if (options.customInstructions) parts.push(`Additional focus: ${options.customInstructions}`);
	if (options.concise) parts.push(CONCISE_RETRY_NOTE);
	return parts.join("\n\n");
}

/** Instructions for the history checkpoint, including consolidation of a previous checkpoint. */
function buildHistoryInstructions(options: InstructionOptions): string {
	const parts = [
		"Write a structured context checkpoint of the conversation in <conversation> so that another model can continue the work without the original messages.",
	];
	if (options.hasPreviousSummary) {
		parts.push(
			"The <previous-summary> is the checkpoint for everything that happened before this conversation. Produce one consolidated checkpoint that covers both: keep facts that are still true, move finished work to Done, update the next steps, and drop details that are stale or superseded. Do not copy the previous checkpoint verbatim.",
		);
	}
	parts.push(
		`Use this exact structure. Keep every section, in order, and write "(none)" for an empty section.\n\n${CHECKPOINT_SECTIONS}`,
	);
	parts.push(
		[
			"Rules:",
			"- Use terse bullets, not paragraphs.",
			"- Preserve exact file paths, function names, commands, error messages, identifiers, and numeric values.",
			"- Record user instructions and corrections faithfully.",
			`- ${summaryLengthRule(options.targetTokens)}`,
			"- Do not mention this summarization request or that the context was compacted.",
			"- Output only the checkpoint. Do not continue the conversation or answer questions in it.",
		].join("\n"),
	);
	return finishInstructions(parts, options);
}

/** Instructions for the prefix of a split turn whose suffix stays in context. */
function buildTurnPrefixInstructions(options: InstructionOptions): string {
	const parts = [
		"The conversation in <conversation> is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained verbatim after this summary.",
	];
	if (options.hasPreviousSummary) {
		parts.push(
			"The <previous-summary> summarizes the earlier part of this same prefix. Produce one consolidated prefix summary that covers both.",
		);
	}
	parts.push(`Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]`);
	parts.push(
		[
			"Rules:",
			"- Be concise. Focus on what is needed to understand the kept suffix.",
			"- Preserve exact file paths, function names, commands, error messages, and identifiers.",
			`- ${summaryLengthRule(options.targetTokens)}`,
			"- Output only the summary. Do not continue the conversation or answer questions in it.",
		].join("\n"),
	);
	return finishInstructions(parts, options);
}

/** Length target for split-turn prefix summaries. */
function turnPrefixTargetTokens(contextWindow: number): number {
	return Math.max(512, Math.floor(summaryTargetTokens(contextWindow) / 2));
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, it is consolidated with the new messages.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	// Unused. Kept for existing callers; summaries size their output from the model's limits.
	_reserveTokens: number | undefined,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			_reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
}

/**
 * Generate or update a conversation summary and return its provider usage.
 *
 * Histories larger than one request are summarized in chunks folded into one rolling
 * summary; see summarization.ts for request sizing and recovery.
 */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	// Unused. Kept for existing callers; summaries size their output from the model's limits.
	_reserveTokens: number | undefined,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	const targetTokens = summaryTargetTokens(model.contextWindow);
	return summarizeTranscript(
		convertToLlm(currentMessages),
		previousSummary,
		(context) => buildHistoryInstructions({ ...context, targetTokens, customInstructions }),
		{ model, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId },
		{
			label: "Summarization",
			condenseAboveTokens: summaryHardLimitTokens(model.contextWindow),
			condenseTargetTokens: targetTokens,
		},
	);
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	customInstructions: string | undefined,
	options: SummarizationRequestOptions,
): Promise<{ text: string; usage: Usage }> {
	const targetTokens = turnPrefixTargetTokens(options.model.contextWindow);
	return summarizeTranscript(
		convertToLlm(messages),
		undefined,
		(context) => buildTurnPrefixInstructions({ ...context, targetTokens, customInstructions }),
		options,
		{
			label: "Turn prefix summarization",
			condenseAboveTokens: targetTokens * 2,
			condenseTargetTokens: targetTokens,
		},
	);
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settings from settings.json */
	settings: CompactionSettings;
}

export interface PrepareCompactionOptions {
	/**
	 * Estimated tokens of the system prompt and tool definitions. Used to calibrate message
	 * estimates against provider usage and to leave room for the prefix below the threshold.
	 */
	prefixTokens?: number;
	/** Estimated tokens of input added right after compaction, such as a pending prompt. */
	pendingTokens?: number;
}

/**
 * Retained messages may use at most this share of the compaction threshold, so compaction
 * frees at least half of the triggering context even when one recent entry is very large.
 */
const MAX_RETAINED_THRESHOLD_FRACTION = 0.5;

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	contextWindow?: number,
	options: PrepareCompactionOptions = {},
): CompactionPreparation | undefined {
	const normalized = normalizeCompactionSettings(settings);

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const contextMessages = buildSessionContext(pathEntries).messages;
	const tokensBefore = estimateContextTokens(contextMessages).tokens;
	const prefixTokens = normalizeTokenSetting(options.prefixTokens, 0);
	const pendingTokens = normalizeTokenSetting(options.pendingTokens, 0);

	// Retention is an upper target, not a reason to make compaction impossible.
	// Leave room below the trigger for the replacement checkpoint on small models.
	let keepRecentTokens = normalized.keepRecentTokens;
	let maxKeepTokens: number | undefined;
	if (contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0) {
		const threshold = compactionThreshold(contextWindow, normalized);
		keepRecentTokens = Math.min(
			keepRecentTokens,
			Math.max(0, threshold - effectiveReserveTokens(contextWindow, normalized.reserveTokens)),
		);
		// Room left below the trigger for retained messages after the prefix, a full-length
		// checkpoint, and input that arrives right after compaction.
		const roomBelowThreshold = threshold - prefixTokens - pendingTokens - summaryHardLimitTokens(contextWindow);
		maxKeepTokens = Math.max(
			0,
			Math.min(Math.floor(threshold * MAX_RETAINED_THRESHOLD_FRACTION), roomBelowThreshold),
		);
	}
	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens, {
		maxKeepTokens,
		tokenScale: estimateTokenScale(contextMessages, prefixTokens),
	});

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Nothing before the cut can be removed, including right after a compaction that kept
	// everything it could. A later compaction can still make progress once the cut moves.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional routing session ID forwarded without enabling prompt caching
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<CompactionResult<CompactionDetails>> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
	} = preparation;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}
	const requestOptions: SummarizationRequestOptions = {
		model,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
		streamFn,
		retry,
		callbacks,
		sessionId,
	};

	// Generate summaries and merge into one
	let summary: string;
	let summaryUsage: Usage | undefined;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				undefined,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId,
			);
			historyText = historyResult.text;
			summaryUsage = historyResult.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, customInstructions, requestOptions);
		// Merge into single summary
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = addUsage(summaryUsage, turnPrefixResult.usage);
	} else {
		// Just generate history summary
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			undefined,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	// Visible tags share the checkpoint's hard length limit, measured with the same
	// four-characters-per-token estimate as context accounting. Full file tracking
	// remains in details even when visible tags do not fit.
	const checkpointCharLimit = summaryHardLimitTokens(model.contextWindow) * 4;
	summary += formatFileOperations(readFiles, modifiedFiles, Math.max(0, checkpointCharLimit - summary.length));

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}
