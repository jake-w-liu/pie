/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { effectiveReserveTokens } from "./compaction.ts";
import {
	CONCISE_RETRY_NOTE,
	type SummaryInstructionContext,
	summarizeTranscript,
	summaryHardLimitTokens,
	summaryLengthRule,
	summaryTargetTokens,
} from "./summarization.ts";
import {
	computeFileLists,
	createFileOps,
	estimateSerializedSummaryTokens,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
} from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	/** API key for the model */
	apiKey?: string;
	/** Request headers for the model */
	headers?: Record<string, string>;
	/** Provider-scoped environment values for the model */
	env?: Record<string, string>;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt + LLM response (default 16384), capped at half the context window */
	reserveTokens?: number;
	/** Session thinking level. Forwarded so the request uses an effort level the model accepts. */
	thinkingLevel?: ThinkingLevel;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	streamFn?: StreamFn;
	/** Retry policy for transient summarization errors. Reuses coding-agent's `settings.retry`. */
	retry?: RetryPolicy;
	/** Optional callbacks for retry reporting (e.g. TUI retry indicators). */
	callbacks?: RetryCallbacks;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// These don't contribute to conversation content
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from prior generated summaries.
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		const message = getMessageFromEntry(entry);
		if (message) extractFileOpsFromMessage(message, fileOps);
		if ((entry.type === "branch_summary" || entry.type === "compaction") && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) if (typeof f === "string") fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				for (const f of details.modifiedFiles) {
					if (typeof f === "string") fileOps.edited.add(f);
				}
			}
		}
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		const serializedMessage = convertToLlm([message])[0];
		if (!serializedMessage) continue;

		const tokens = estimateSerializedSummaryTokens(serializedMessage);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// Stop - we've hit the budget
			break;
		}

		messages.push(message);
		totalTokens += tokens;
	}

	messages.reverse();
	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_SECTIONS = `## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]`;

interface BranchInstructionOptions extends SummaryInstructionContext {
	targetTokens: number;
	customInstructions?: string;
	replaceInstructions?: boolean;
}

/** Instructions for one branch summary request; later chunks consolidate the summary of earlier ones. */
function buildBranchInstructions(options: BranchInstructionOptions): string {
	const parts: string[] = [];
	if (options.hasPreviousSummary) {
		parts.push(
			"The <previous-summary> summarizes the earlier part of this branch. Produce one consolidated summary that covers both.",
		);
	}
	if (options.replaceInstructions && options.customInstructions) {
		parts.push(options.customInstructions);
	} else {
		parts.push(
			`Create a structured summary of this conversation branch for context when returning later.\n\nUse this EXACT format:\n\n${BRANCH_SUMMARY_SECTIONS}`,
		);
		parts.push(
			`Keep each section concise. Preserve exact file paths, function names, and error messages. ${summaryLengthRule(options.targetTokens)}`,
		);
		if (options.customInstructions) parts.push(`Additional focus: ${options.customInstructions}`);
	}
	if (options.concise) parts.push(CONCISE_RETRY_NOTE);
	return parts.join("\n\n");
}

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		thinkingLevel,
		streamFn,
		retry,
		callbacks,
	} = options;

	// Token budget = context window minus reserved space for prompt + response. The reserve is capped as
	// for compaction, so the default reserve, a whole 16k window, leaves a budget on small models.
	const contextWindow = model.contextWindow || 128000;
	const reserve = effectiveReserveTokens(contextWindow, reserveTokens);
	const tokenBudget = contextWindow - reserve;
	if (!Number.isFinite(tokenBudget) || tokenBudget <= 0 || !Number.isFinite(reserveTokens) || reserveTokens < 0) {
		return {
			error: "No input budget is available for branch summarization. Reduce reserveTokens or use a larger-context model.",
		};
	}

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return entries.some((entry) => getMessageFromEntry(entry) !== undefined)
			? { error: "No branch content fits the summarization input budget. Use a larger-context model." }
			: { summary: "No content to summarize" };
	}

	// Serialized transcript requests, chunked to fit the model and retried with less reasoning or
	// smaller input when the model runs out of room. Prefer the session stream function so SDK
	// request behavior (timeouts, retries, attribution headers) stays consistent without running
	// through agent state/events.
	const targetTokens = Math.max(1024, Math.floor(summaryTargetTokens(model.contextWindow) / 2));
	let summaryText: string;
	let usage: Usage;
	try {
		const result = await summarizeTranscript(
			convertToLlm(messages),
			undefined,
			(context) => buildBranchInstructions({ ...context, targetTokens, customInstructions, replaceInstructions }),
			{ model, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks },
			{ label: "Branch summarization", condenseAboveTokens: targetTokens * 2, condenseTargetTokens: targetTokens },
		);
		summaryText = result.text;
		usage = result.usage;
	} catch (error) {
		if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
			return { aborted: true };
		}
		return { error: error instanceof Error ? error.message : String(error) };
	}

	let summary = summaryText;

	// Prepend preamble to provide context about the branch summary
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary within the checkpoint's hard length limit.
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	const checkpointCharLimit = summaryHardLimitTokens(model.contextWindow) * 4;
	summary += formatFileOperations(readFiles, modifiedFiles, Math.max(0, checkpointCharLimit - summary.length));

	return {
		summary,
		usage,
		readFiles,
		modifiedFiles,
	};
}
