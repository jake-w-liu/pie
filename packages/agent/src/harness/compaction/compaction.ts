import {
	type Api,
	type AssistantMessage,
	type Context,
	contentText,
	type Message,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	type SimpleStreamOptions,
	type Tool,
	type Usage,
	uuidv7,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import { buildSessionContext } from "../session/context.ts";
import type { CompactionEntry, Entry } from "../session/types.ts";
import { CompactionError, err, ok, type Result } from "../types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: Entry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: Entry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: Entry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactResult<T = unknown> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Usage from the LLM call(s) that generated this summary, if available. */
	usage?: Usage;
	/** Retained recent messages stored directly on the compaction entry. */
	retainedTail: AgentMessage[];
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

export async function completeSimpleWithRetries(
	models: Models,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	return retryAssistantCall(
		() => models.completeSimple(model, context, requestOptions),
		retry,
		requestOptions.signal,
		callbacks,
	);
}

function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/**
 * Fractional context-window ceiling for the compaction trigger.
 * Prevents large-context models from waiting until nearly full: the trigger is
 * `min(ratio * contextWindow, contextWindow - reserveTokens)`.
 */
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.87;

/** Token budget for a summarization request, shared by compaction and branch summaries. */
export function getSummarizationTokenBudget(reserveTokens: number, ratio: number, modelMaxTokens: number): number {
	const effectiveReserve =
		Number.isFinite(reserveTokens) && reserveTokens > 0 ? reserveTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	const reserveBudget = Math.max(1, Math.floor(effectiveReserve * ratio));
	const modelBudget =
		Number.isFinite(modelMaxTokens) && modelMaxTokens > 0
			? Math.max(1, Math.floor(modelMaxTokens))
			: Number.POSITIVE_INFINITY;
	return Math.min(reserveBudget, modelBudget);
}

/**
 * Returns an error message when a summarization response cannot be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
 * Shared by compaction and branch summarization; Result-throwing wrappers differ per caller.
 */
export function getSummarizationFailure(
	response: AssistantMessage,
	label: string,
	summaryText = contentText(response.content),
): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	if (!response.content.some((block) => block.type === "toolCall") && summaryText.trim().length === 0) {
		return `${label} failed: response contained no summary text`;
	}
	return undefined;
}

function extractSummaryText(response: AssistantMessage, label: string): Result<string, CompactionError> {
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || `${label} aborted`));
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return err(new CompactionError("summarization_failed", `${label} attempted to call a tool`));
	}
	const text = contentText(response.content);
	const failure = getSummarizationFailure(response, label, text);
	if (failure) {
		return err(new CompactionError("summarization_failed", failure));
	}
	return ok(text);
}

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
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

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: Entry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
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

/**
 * Return whether context usage exceeds the configured compaction threshold.
 *
 * The ratio boundary prevents large-context models from waiting until nearly
 * full, while the reserve boundary remains authoritative when it is stricter.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0 || contextTokens <= 0) return false;

	const reserveTokens = Number.isFinite(settings.reserveTokens) ? Math.max(0, settings.reserveTokens) : 0;
	const ratioBoundary = Math.floor(contextWindow * DEFAULT_COMPACTION_TRIGGER_RATIO);
	const reserveBoundary = contextWindow - reserveTokens;
	const triggerBoundary = Math.max(1, Math.min(ratioBoundary, reserveBoundary));
	return contextTokens >= triggerBoundary;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
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
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "active_tools_change":
			case "compaction":
			case "branch_summary":
			case "custom":
				break;
		}
		if (entry.type === "branch_summary") cutPoints.push(i);
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (
				role === "user" ||
				role === "bashExecution" ||
				role === "custom" ||
				role === "branchSummary" ||
				role === "compactionSummary"
			) {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: Entry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
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
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries; absorb adjacent
		// metadata entries that do not affect context.
		if (prevEntry.type === "compaction" || prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const startsTurn =
		cutEntry.type === "branch_summary" ||
		(cutEntry.type === "message" &&
			(cutEntry.message.role === "user" ||
				cutEntry.message.role === "bashExecution" ||
				cutEntry.message.role === "custom" ||
				cutEntry.message.role === "branchSummary" ||
				cutEntry.message.role === "compactionSummary"));
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * Cache-reusing compaction directive, delivered as the FINAL user message after
 * the replayed conversation prefix. Keeping the conversation's own system prompt,
 * tools, and messages in front of it makes the summarization call a genuine prefix
 * of the last routed request, so the provider's warm prefix cache is reused.
 */
export const SUMMARIZATION_INSTRUCTION = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Goal
- [what the user is trying to accomplish; quote verbatim where the exact wording matters]

## Constraints & Preferences
- [constraints, preferences, or requirements the user mentioned; or "(none)"]

## Progress
### Done
- [x] [completed tasks/changes]

### In Progress
- [ ] [current work]

### Blocked
- [issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [brief rationale]

## Next Steps
1. [ordered list of what should happen next]

## Critical Context
- [data, examples, or references needed to continue; or "(none)"]

Rules:
- Write concise English engineering prose. Preserve exact file paths, function names, commands, error strings, identifiers, numeric values, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- Do NOT continue the conversation or respond to any question in it; ONLY output the structured summary.`;

/** Live-conversation prefix for cache-reusing summarization. Omit to use the serialized-text fallback. */
export interface SummarizationCacheReuse {
	/** Live conversation system prompt, replayed verbatim for prefix alignment. */
	systemPrompt?: string;
	/** Live conversation tool schemas, replayed for prefix alignment. */
	tools?: readonly Tool[];
}

/** Build the provider context for a standalone serialized-text summary request. */
export function buildSummarizationContext(promptText: string): Context {
	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	};
}

/**
 * Build a cache-reusing summarization context: replay the live system prompt and
 * tool schemas verbatim, append the conversation messages as a prefix, and deliver
 * the compaction instruction as the FINAL user message.
 */
export function buildCacheReusingSummarizationContext(
	systemPrompt: string,
	tools: readonly Tool[] | undefined,
	instruction: string,
	messages: readonly Message[],
): Context {
	const context: Context = {
		systemPrompt,
		messages: [
			...messages,
			{
				role: "user",
				content: [{ type: "text", text: instruction }],
				timestamp: Date.now(),
			},
		],
	};
	if (tools !== undefined && tools.length > 0) {
		context.tools = [...tools];
	}
	return context;
}

/**
 * Build the compaction instruction for the cache-reusing path, merging any prior
 * summary and custom focus instead of copying a prior checkpoint verbatim.
 */
export function buildCompactionInstruction(
	previousSummary: string | undefined,
	customInstructions: string | undefined,
): string {
	let instruction = SUMMARIZATION_INSTRUCTION;
	if (previousSummary) {
		instruction += `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\nIf the conversation already contained a prior checkpoint, do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`;
	}
	if (customInstructions) {
		instruction += `\n\nAdditional focus: ${customInstructions}`;
	}
	return instruction;
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	cacheReuse?: SummarizationCacheReuse,
): Promise<Result<string, CompactionError>> {
	const result = await generateSummaryWithUsage(
		currentMessages,
		models,
		model,
		reserveTokens,
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
		callbacks,
		cacheReuse,
	);
	return result.ok ? ok(result.value.text) : err(result.error);
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	cacheReuse?: SummarizationCacheReuse,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = getSummarizationTokenBudget(reserveTokens, 0.8, model.maxTokens);
	const llmMessages = convertToLlm(currentMessages);

	// Cache-reusing path: replay the live system prompt + messages as a prefix and
	// append the compaction instruction as the final user message.
	if (cacheReuse?.systemPrompt !== undefined) {
		const instruction = buildCompactionInstruction(previousSummary, customInstructions);
		const completionOptions =
			model.reasoning && thinkingLevel && thinkingLevel !== "off"
				? { maxTokens, signal, reasoning: thinkingLevel }
				: { maxTokens, signal };
		const response = await completeSimpleWithRetries(
			models,
			model,
			buildCacheReusingSummarizationContext(cacheReuse.systemPrompt, cacheReuse.tools, instruction, llmMessages),
			completionOptions,
			retry,
			callbacks,
		);
		const text = extractSummaryText(response, "Summarization");
		return text.ok ? ok({ text: text.value, usage: response.usage }) : err(text.error);
	}

	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	const conversationText = serializeConversation(llmMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };

	const response = await completeSimpleWithRetries(
		models,
		model,
		buildSummarizationContext(promptText),
		completionOptions,
		retry,
		callbacks,
	);
	const text = extractSummaryText(response, "Summarization");
	return text.ok ? ok({ text: text.value, usage: response.usage }) : err(text.error);
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
	/** Messages summarized into the history summary. */
	messagesToSummarize: AgentMessage[];
	/** Prefix messages summarized separately when compaction splits a turn. */
	turnPrefixMessages: AgentMessage[];
	/** Recent messages retained after compaction and stored on the compaction entry. */
	retainedTail: AgentMessage[];
	/** Whether compaction splits a turn. */
	isSplitTurn: boolean;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Previous compaction summary used for iterative updates. */
	previousSummary?: string;
	/** File operations extracted from summarized history. */
	fileOps: FileOperations;
	/** Settings used to prepare compaction. */
	settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: Entry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let compactableEntries = pathEntries;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
			type: "message",
			id: `${prevCompaction.id}:retained:${index}`,
			parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
			seq: prevCompaction.seq,
			timestamp: message.timestamp,
			message,
		}));
		compactableEntries = [...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
	}
	const boundaryEnd = compactableEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = 0; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const retainedTail: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) retainedTail.push(msg);
	}

	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export async function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<Api>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<Result<CompactResult, CompactionError>> {
	const {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				models,
				model,
				settings.reserveTokens,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				retry,
				callbacks,
			);
			if (!historyResult.ok) return err(historyResult.error);
			historyText = historyResult.value.text;
			historyUsage = historyResult.value.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			models,
			model,
			settings.reserveTokens,
			signal,
			thinkingLevel,
			retry,
			callbacks,
		);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
		summaryUsage = historyUsage
			? combineUsage(historyUsage, turnPrefixResult.value.usage)
			: turnPrefixResult.value.usage;
	} else {
		// Defense in depth: if nothing is to summarize (no split turn, empty history),
		// avoid issuing an LLM call against an empty conversation. Return a concrete
		// empty-history summary so downstream persists a stateful compaction entry
		// instead of blocking on or fabricating a model summary.
		if (messagesToSummarize.length === 0) {
			summary = "No prior history before the retained context.";
			summaryUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		} else {
			const summaryResult = await generateSummaryWithUsage(
				messagesToSummarize,
				models,
				model,
				settings.reserveTokens,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				retry,
				callbacks,
			);
			if (!summaryResult.ok) return err(summaryResult.error);
			summary = summaryResult.value.text;
			summaryUsage = summaryResult.value.usage;
		}
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary,
		tokensBefore,
		usage: summaryUsage,
		retainedTail,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	});
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = getSummarizationTokenBudget(reserveTokens, 0.5, model.maxTokens);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };
	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		retry,
		callbacks,
	);
	const text = extractSummaryText(response, "Turn prefix summarization");
	return text.ok ? ok({ text: text.value, usage: response.usage }) : err(text.error);
}
