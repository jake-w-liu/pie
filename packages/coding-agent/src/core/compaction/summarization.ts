/**
 * Summarization engine shared by compaction, turn-prefix, and branch summaries.
 *
 * Every summary request sends a serialized transcript under a dedicated summarizer
 * system prompt, without tools. Requests are sized from the model's own limits
 * instead of a fixed output cap:
 *
 * - The transcript is split into chunks that fit the context window next to a
 *   generous output allowance. Chunks are folded into one rolling summary, so a
 *   history of any length can be summarized.
 * - The output limit is the model's own limit, reduced only to fit the remaining
 *   context. Reasoning shares that limit on some providers (adaptive Anthropic
 *   thinking, OpenAI Responses), so a small fixed cap made high reasoning levels
 *   fail deterministically.
 * - A response that stops at the output limit is retried once with reduced
 *   reasoning and a request for a shorter summary. A response that still stops
 *   there, or a request that overflows the context, is retried on smaller input
 *   before the operation fails.
 * - A summary longer than its hard limit is condensed once, so checkpoints do not
 *   grow without bound across repeated compactions.
 */

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	clampThinkingLevel,
	contentText,
	isContextOverflow,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { SUMMARIZATION_SYSTEM_PROMPT, serializeMessage, truncateForSummary } from "./utils.ts";

// ============================================================================
// Limits
// ============================================================================

/**
 * Planning estimate for request sizing. Code, JSON, and logs tokenize denser than
 * the chars/4 prose estimate used for context accounting, so chunks and output
 * limits are planned at three characters per token.
 */
const PLANNING_CHARS_PER_TOKEN = 3;

/** Same margin pi-ai subtracts from the context window when it clamps a request's output limit. */
const PROVIDER_CONTEXT_SAFETY_TOKENS = 4096;

/** Smallest output allowance (reasoning plus summary text) planned for one request. */
const MIN_SUMMARY_OUTPUT_TOKENS = 1024;

/**
 * Share of the context window kept free for one request's output when the model allows
 * that much. High reasoning levels can spend tens of thousands of tokens before the
 * summary text starts.
 */
const SUMMARY_OUTPUT_WINDOW_FRACTION = 0.25;

/** Smallest transcript allowance for one request; below this the model cannot summarize. */
const MIN_TRANSCRIPT_TOKENS = 256;

/** A previous summary may use at most this share of a request's input allowance. */
const MAX_PREVIOUS_SUMMARY_INPUT_FRACTION = 1 / 3;

/** Bounds how often one chunk is split or truncated after context-overflow errors. */
const MAX_SHRINK_DEPTH = 6;

/**
 * Splits allowed after a chunk stopped at the output limit even with reduced reasoning.
 * Smaller input helps only when the output limit is small relative to the input, so the
 * request count stays bounded when a provider stops at its limit regardless of input.
 */
const MAX_LENGTH_SPLITS = 1;

/** A single transcript block shorter than this is not truncated further. */
const MIN_SHRINKABLE_BLOCK_CHARS = 2000;

/** Checkpoint length targets, as a share of the context window, in tokens. */
const SUMMARY_TARGET_WINDOW_FRACTION = 0.03;
const SUMMARY_TARGET_MIN_TOKENS = 1024;
const SUMMARY_TARGET_MAX_TOKENS = 8192;

/** A checkpoint longer than this multiple of its target is condensed once. */
const SUMMARY_HARD_LIMIT_MULTIPLIER = 2;

/** Characters per token for measuring finished summaries, matching context accounting. */
const SUMMARY_CHARS_PER_TOKEN = 4;

function isPositiveFinite(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function planningTokens(text: string): number {
	return Math.ceil(text.length / PLANNING_CHARS_PER_TOKEN);
}

/** Estimate the size of finished summary text with the chars/4 context-accounting estimate. */
export function estimateSummaryTokens(text: string): number {
	return Math.ceil(text.length / SUMMARY_CHARS_PER_TOKEN);
}

/** Target checkpoint length in tokens for a model's context window. */
export function summaryTargetTokens(contextWindow: number): number {
	if (!isPositiveFinite(contextWindow)) return SUMMARY_TARGET_MAX_TOKENS;
	return Math.min(
		SUMMARY_TARGET_MAX_TOKENS,
		Math.max(SUMMARY_TARGET_MIN_TOKENS, Math.floor(contextWindow * SUMMARY_TARGET_WINDOW_FRACTION)),
	);
}

/** Checkpoint length in tokens above which a summary is condensed. */
export function summaryHardLimitTokens(contextWindow: number): number {
	return summaryTargetTokens(contextWindow) * SUMMARY_HARD_LIMIT_MULTIPLIER;
}

/** The model's usable output limit, never above its context window; undefined when unknown. */
function modelOutputLimit(model: Model<any>): number | undefined {
	const window = isPositiveFinite(model.contextWindow) ? model.contextWindow : undefined;
	const maxTokens = isPositiveFinite(model.maxTokens) ? Math.floor(model.maxTokens) : undefined;
	if (maxTokens === undefined) return window;
	return window === undefined ? maxTokens : Math.min(maxTokens, window);
}

/** Output tokens every request plans to leave free: reasoning plus summary text. */
function summaryOutputReserve(model: Model<any>): number {
	const outputLimit = modelOutputLimit(model) ?? MIN_SUMMARY_OUTPUT_TOKENS;
	const window = isPositiveFinite(model.contextWindow) ? model.contextWindow : Number.POSITIVE_INFINITY;
	const desired = Math.max(MIN_SUMMARY_OUTPUT_TOKENS, Math.floor(window * SUMMARY_OUTPUT_WINDOW_FRACTION));
	return Math.max(1, Math.min(outputLimit, desired));
}

/**
 * Input tokens available to one request after the output reserve and provider margin,
 * or Infinity when the model has no known context window.
 */
function requestInputBudget(model: Model<any>): number {
	if (!isPositiveFinite(model.contextWindow)) return Number.POSITIVE_INFINITY;
	return model.contextWindow - summaryOutputReserve(model) - PROVIDER_CONTEXT_SAFETY_TOKENS;
}

/**
 * Output limit for one request: the model's limit, reduced to the context left after the
 * conservatively estimated prompt. Undefined leaves the limit to the provider.
 */
function requestOutputLimit(model: Model<any>, context: Context): number | undefined {
	const outputLimit = modelOutputLimit(model);
	if (outputLimit === undefined) return undefined;
	if (!isPositiveFinite(model.contextWindow)) return outputLimit;
	const promptTokens =
		planningTokens(context.systemPrompt ?? "") +
		context.messages.reduce(
			(sum, message) => sum + (message.role === "user" ? planningTokens(contentText(message.content, "")) : 0),
			0,
		);
	const available = model.contextWindow - promptTokens - PROVIDER_CONTEXT_SAFETY_TOKENS;
	return Math.max(1, Math.min(outputLimit, available));
}

// ============================================================================
// Requests
// ============================================================================

export interface SummarizationRequestOptions {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Session thinking level. Forwarded so requests use an effort level the model accepts. */
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
	/** Routing session ID. Each physical request receives a fresh one when omitted. */
	sessionId?: string;
}

export interface SummaryText {
	text: string;
	usage: Usage;
}

/** Context for building one request's instruction block. */
export interface SummaryInstructionContext {
	/** The request carries a <previous-summary> to consolidate with the transcript. */
	hasPreviousSummary: boolean;
	/** A previous attempt stopped at the output limit; ask for a shorter summary. */
	concise: boolean;
}

export type SummaryInstructionBuilder = (context: SummaryInstructionContext) => string;

export interface SummarizeTranscriptOptions {
	/** Label used in error messages, for example "Summarization". */
	label: string;
	/** Condense the final summary once when it exceeds this many tokens. */
	condenseAboveTokens?: number;
	/** Length target for the condensed summary, in tokens. */
	condenseTargetTokens?: number;
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

/** Add usage, treating a missing side as zero. */
export function addUsage(first: Usage | undefined, second: Usage): Usage {
	return first ? combineUsage(first, second) : second;
}

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
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

function createAbortError(response: AssistantMessage, label: string): Error {
	const error = new Error(response.errorMessage || `${label} aborted`);
	error.name = "AbortError";
	return error;
}

function createRequestOptions(
	options: SummarizationRequestOptions,
	maxTokens: number | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const requestOptions: SimpleStreamOptions = {
		signal: options.signal,
		apiKey: options.apiKey,
		headers: options.headers,
		env: options.env,
		sessionId: options.sessionId,
	};
	if (maxTokens !== undefined) requestOptions.maxTokens = maxTokens;
	if (options.model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		requestOptions.reasoning = thinkingLevel;
	}
	return requestOptions;
}

const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Reasoning level for summary requests: the session level, capped at "high". A summary is
 * transcription work, so higher levels are capped to bound latency and output spend; the
 * output limit is shared with reasoning on some providers. Levels at or below "high" pass
 * through unchanged so the request keeps an effort the model accepts.
 */
function summaryThinkingLevel(model: Model<any>, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
	if (!model.reasoning || !level || level === "off") return undefined;
	if (THINKING_LEVEL_ORDER.indexOf(level) <= THINKING_LEVEL_ORDER.indexOf("high")) return level;
	return clampThinkingLevel(model, "high");
}

/**
 * Lowest reasoning level the model lists above "off", when it is below `level`. "off" is not
 * used because disabling thinking changes the request shape, while a listed level keeps the
 * request within the levels the model catalog declares.
 */
function reducedThinkingLevel(model: Model<any>, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
	if (!model.reasoning || !level || level === "off") return undefined;
	const floor = clampThinkingLevel(model, "minimal");
	return THINKING_LEVEL_ORDER.indexOf(floor) < THINKING_LEVEL_ORDER.indexOf(level) ? floor : undefined;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	options.signal?.throwIfAborted();
	// Avoid cache writes for one-off summaries. Reuse caller-supplied routing when available;
	// callers without a session ID receive a fresh routing ID.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
	let usage: Usage | undefined;
	const produce = async (): Promise<AssistantMessage> => {
		const response = streamFn
			? await (await streamFn(model, context, requestOptions)).result()
			: await completeSimple(model, context, requestOptions);
		usage = addUsage(usage, response.usage);
		return response;
	};
	const response = await retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
	return { ...response, usage: usage ?? response.usage };
}

function buildRequestText(transcript: string, previousSummary: string | undefined, instructions: string): string {
	let text = `<conversation>\n${transcript}\n</conversation>\n\n`;
	if (previousSummary !== undefined) {
		text += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	return text + instructions;
}

function buildRequestContext(text: string): Context {
	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
	};
}

type AttemptOutcome =
	| { kind: "ok"; text: string; usage: Usage }
	| { kind: "length"; usage: Usage; output: number }
	| { kind: "overflow"; usage: Usage; message: string };

/** Send one request and classify its response. Throws for aborts and non-recoverable failures. */
async function attemptSummary(
	requestText: string,
	thinkingLevel: ThinkingLevel | undefined,
	label: string,
	options: SummarizationRequestOptions,
): Promise<AttemptOutcome> {
	const context = buildRequestContext(requestText);
	const response = await completeSummarization(
		options.model,
		context,
		createRequestOptions(options, requestOutputLimit(options.model, context), thinkingLevel),
		options.streamFn,
		options.retry,
		options.callbacks,
	);
	if (response.stopReason === "aborted") throw createAbortError(response, label);
	if (response.stopReason === "length") {
		return { kind: "length", usage: response.usage, output: response.usage.output };
	}
	if (response.stopReason === "error" && isContextOverflow(response, options.model.contextWindow)) {
		return { kind: "overflow", usage: response.usage, message: response.errorMessage || "context overflow" };
	}
	const text = contentText(response.content);
	const failure = getSummarizationFailure(response, label, text);
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error(`${label} attempted to call a tool`);
	}
	return { kind: "ok", text, usage: response.usage };
}

// ============================================================================
// Transcript folding
// ============================================================================

interface FoldState {
	label: string;
	options: SummarizationRequestOptions;
	buildInstructions: SummaryInstructionBuilder;
	/** Input tokens one request may use; Infinity when the model has no known window. */
	inputBudget: number;
}

/** Previous summary as sent: unchanged unless it would crowd out the transcript. */
function fitPreviousSummary(previousSummary: string | undefined, state: FoldState): string | undefined {
	if (previousSummary === undefined || !Number.isFinite(state.inputBudget)) return previousSummary;
	const maxChars = Math.floor(state.inputBudget * MAX_PREVIOUS_SUMMARY_INPUT_FRACTION) * PLANNING_CHARS_PER_TOKEN;
	return previousSummary.length > maxChars
		? truncateForSummary(previousSummary, Math.max(0, maxChars))
		: previousSummary;
}

/** Transcript characters one request can carry next to its previous summary and instructions. */
function transcriptBudgetChars(previousSummary: string | undefined, state: FoldState): number {
	if (!Number.isFinite(state.inputBudget)) return Number.POSITIVE_INFINITY;
	const fixedTokens =
		planningTokens(SUMMARIZATION_SYSTEM_PROMPT) +
		planningTokens(
			buildRequestText(
				"",
				previousSummary,
				state.buildInstructions({ hasPreviousSummary: previousSummary !== undefined, concise: true }),
			),
		);
	const available = state.inputBudget - fixedTokens;
	if (available < MIN_TRANSCRIPT_TOKENS) {
		throw new Error(
			`${state.label} failed: the model's ${state.options.model.contextWindow}-token context window leaves no room for summarization input`,
		);
	}
	return available * PLANNING_CHARS_PER_TOKEN;
}

/** Remaining recovery steps for one chunk. */
interface ShrinkBudget {
	/** Split or truncate steps left after context-overflow errors. */
	depth: number;
	/** Splits left after output-limit stops with reduced reasoning. */
	lengthSplits: number;
}

const INITIAL_SHRINK_BUDGET: ShrinkBudget = { depth: MAX_SHRINK_DEPTH, lengthSplits: MAX_LENGTH_SPLITS };

/** Summarize one chunk, retrying with less reasoning or smaller input when the model runs out of room. */
async function summarizeChunk(
	blocks: string[],
	previousSummary: string | undefined,
	state: FoldState,
	shrink: ShrinkBudget,
): Promise<SummaryText> {
	const sentPrevious = fitPreviousSummary(previousSummary, state);
	const transcript = blocks.join("\n\n");
	const level = summaryThinkingLevel(state.options.model, state.options.thinkingLevel);
	const reduced = reducedThinkingLevel(state.options.model, level);
	let usage: Usage | undefined;

	for (const concise of [false, true]) {
		const instructions = state.buildInstructions({ hasPreviousSummary: sentPrevious !== undefined, concise });
		const outcome = await attemptSummary(
			buildRequestText(transcript, sentPrevious, instructions),
			concise ? (reduced ?? level) : level,
			state.label,
			state.options,
		);
		usage = addUsage(usage, outcome.usage);
		if (outcome.kind === "ok") return { text: outcome.text, usage };

		if (outcome.kind === "overflow") {
			const shrunk = await summarizeShrunk(blocks, previousSummary, state, shrink, outcome.message, false);
			return { text: shrunk.text, usage: addUsage(usage, shrunk.usage) };
		}
		if (concise) {
			const shrunk = await summarizeShrunk(
				blocks,
				previousSummary,
				state,
				shrink,
				`generation hit the output limit after ${outcome.output} tokens even with reduced reasoning`,
				true,
			);
			return { text: shrunk.text, usage: addUsage(usage, shrunk.usage) };
		}
	}
	// The loop always returns or throws; this keeps the control flow explicit for the type checker.
	throw new Error(`${state.label} failed: no summary was produced`);
}

/** Retry a chunk on smaller input: split multi-block chunks, truncate a single oversized block. */
async function summarizeShrunk(
	blocks: string[],
	previousSummary: string | undefined,
	state: FoldState,
	shrink: ShrinkBudget,
	reason: string,
	afterLengthStop: boolean,
): Promise<SummaryText> {
	const canSplit = blocks.length > 1;
	const canTruncate = blocks.length === 1 && blocks[0].length > MIN_SHRINKABLE_BLOCK_CHARS;
	const budgetLeft = shrink.depth > 0 && (!afterLengthStop || shrink.lengthSplits > 0);
	if (!budgetLeft || (!canSplit && !canTruncate)) {
		throw new Error(`${state.label} failed: ${reason}`);
	}
	const next: ShrinkBudget = {
		depth: shrink.depth - 1,
		lengthSplits: afterLengthStop ? shrink.lengthSplits - 1 : shrink.lengthSplits,
	};
	if (canSplit) {
		const middle = Math.ceil(blocks.length / 2);
		const first = await summarizeChunk(blocks.slice(0, middle), previousSummary, state, next);
		const second = await summarizeChunk(blocks.slice(middle), first.text, state, next);
		return { text: second.text, usage: addUsage(first.usage, second.usage) };
	}
	const block = blocks[0];
	return summarizeChunk([truncateForSummary(block, Math.floor(block.length / 2))], previousSummary, state, next);
}

/** Condense an over-long summary once. Returns the original text when condensing fails. */
async function condenseSummary(
	summary: string,
	targetTokens: number,
	state: FoldState,
): Promise<{ text: string; usage: Usage | undefined }> {
	const level = summaryThinkingLevel(state.options.model, state.options.thinkingLevel);
	const reduced = reducedThinkingLevel(state.options.model, level);
	let usage: Usage | undefined;
	for (const concise of [false, true]) {
		const requestText = `<checkpoint>\n${summary}\n</checkpoint>\n\n${buildCondenseInstructions(targetTokens, concise)}`;
		let outcome: AttemptOutcome;
		try {
			outcome = await attemptSummary(requestText, concise ? (reduced ?? level) : level, state.label, state.options);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			// The uncondensed summary is complete and valid; keep it rather than failing the operation.
			return { text: summary, usage };
		}
		usage = addUsage(usage, outcome.usage);
		if (outcome.kind === "ok") {
			return { text: outcome.text.length < summary.length ? outcome.text : summary, usage };
		}
		if (outcome.kind === "overflow") break;
	}
	return { text: summary, usage };
}

function buildCondenseInstructions(targetTokens: number, concise: boolean): string {
	const words = Math.max(1, Math.round(targetTokens * 0.75));
	return `The <checkpoint> above is a context checkpoint that has grown too long. Rewrite it as one shorter checkpoint with the same section structure, under about ${targetTokens} tokens (roughly ${words} words).

Keep the goal, user constraints and corrections, current state, open problems, next steps, and exact identifiers (file paths, function names, commands, error messages, numeric values). Merge duplicates and drop stale or low-value detail.

Output only the checkpoint.${concise ? "\n\nA previous attempt was cut off at the output limit. Write a much shorter checkpoint." : ""}`;
}

/**
 * Summarize LLM messages into one summary, folding an optional previous summary in.
 *
 * The transcript is split into chunks that fit one request; each chunk is summarized
 * together with the summary of everything before it. At least one request is made,
 * so an empty transcript consolidates the previous summary.
 */
export async function summarizeTranscript(
	messages: readonly Message[],
	previousSummary: string | undefined,
	buildInstructions: SummaryInstructionBuilder,
	options: SummarizationRequestOptions,
	summarizeOptions: SummarizeTranscriptOptions,
): Promise<SummaryText> {
	options.signal?.throwIfAborted();
	const state: FoldState = {
		label: summarizeOptions.label,
		options,
		buildInstructions,
		inputBudget: requestInputBudget(options.model),
	};
	const blocks = messages.map(serializeMessage).filter((block) => block.length > 0);

	let summary = previousSummary;
	let usage: Usage | undefined;
	let index = 0;
	do {
		const budgetChars = transcriptBudgetChars(fitPreviousSummary(summary, state), state);
		const chunk: string[] = [];
		let chunkChars = 0;
		while (index < blocks.length) {
			const block = blocks[index];
			const separator = chunk.length > 0 ? 2 : 0;
			if (chunk.length > 0 && chunkChars + separator + block.length > budgetChars) break;
			// A single block larger than one request keeps its head and tail.
			const fitted = block.length > budgetChars ? truncateForSummary(block, Math.floor(budgetChars)) : block;
			chunk.push(fitted);
			chunkChars += separator + fitted.length;
			index++;
		}
		const result = await summarizeChunk(chunk, summary, state, INITIAL_SHRINK_BUDGET);
		summary = result.text;
		usage = addUsage(usage, result.usage);
	} while (index < blocks.length);

	const finalSummary = summary ?? "";
	if (!usage) throw new Error(`${state.label} failed: no summary was produced`);

	const condenseAbove = summarizeOptions.condenseAboveTokens;
	if (condenseAbove !== undefined && estimateSummaryTokens(finalSummary) > condenseAbove) {
		const condensed = await condenseSummary(
			finalSummary,
			summarizeOptions.condenseTargetTokens ?? Math.floor(condenseAbove / SUMMARY_HARD_LIMIT_MULTIPLIER),
			state,
		);
		return { text: condensed.text, usage: condensed.usage ? addUsage(usage, condensed.usage) : usage };
	}
	return { text: finalSummary, usage };
}

/** Length rule shared by every summary instruction block. */
export function summaryLengthRule(targetTokens: number): string {
	const words = Math.max(1, Math.round(targetTokens * 0.75));
	return `Keep the whole summary under about ${targetTokens} tokens (roughly ${words} words). When space is short, drop stale or low-value detail first.`;
}

/** Note appended when a previous attempt stopped at the output limit. */
export const CONCISE_RETRY_NOTE =
	"A previous attempt was cut off at the output limit. Write a noticeably shorter summary.";
