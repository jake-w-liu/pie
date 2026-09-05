import { sleep } from "./sleep.ts";

type FetchInput = Parameters<typeof fetch>[0];

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Upper bound for honoring server-sent Retry-After delays. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Parse a Retry-After value (delta-seconds or HTTP-date) into milliseconds,
 * capped so a malicious clock never stalls management requests for long.
 */
function retryAfterMs(response: Response): number | undefined {
	const raw = response.headers.get("retry-after");
	if (!raw) return undefined;
	const seconds = Number(raw.trim());
	if (Number.isFinite(seconds)) {
		return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
	}
	const date = Date.parse(raw);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_AFTER_MS));
}

export interface FetchRetryOptions {
	/** Number of additional attempts after the initial request. Defaults to two. */
	maxRetries?: number;
	/** Retry transient HTTP responses as well as transport failures. Defaults to true. */
	retryOnStatus?: boolean;
	/** Overall time budget shared by all attempts. */
	timeoutMs?: number;
	/** Per-attempt timeout. A new timeout is created for every attempt. */
	attemptTimeoutMs?: number;
}

/**
 * Fetch a management HTTP resource with a bounded immediate retry.
 *
 * This is intentionally a transport-level helper for idempotent management
 * requests (catalogs and managed-tool downloads). It must not be used for
 * agent/model operations: those can fail after the HTTP request starts and are
 * retried by their semantic caller instead.
 *
 * Caller cancellation and timeoutMs are terminal. attemptTimeoutMs aborts
 * only the current attempt so a hung connection can be retried.
 */
export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const parentSignal = init?.signal ?? undefined;
	const timeoutSignal =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const attemptTimeoutMs =
		options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	for (let attempt = 0; ; attempt++) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			if (!shouldRetry) return response;
			try {
				await response.body?.cancel();
			} catch {
				// The response is being discarded before a retry. There is nothing useful to
				// do if cancelling its body also fails.
			}
			// Honor server-sent backoff on rate limiting / overload instead of
			// hammering immediately. Other statuses retry at once, as before.
			const backoffMs = response.status === 429 || response.status === 503 ? (retryAfterMs(response) ?? 0) : 0;
			if (backoffMs > 0) {
				const abortSignals = [parentSignal, timeoutSignal].filter(
					(candidate): candidate is AbortSignal => candidate !== undefined,
				);
				await sleep(backoffMs, abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0]).catch(
					() => {
						parentSignal?.throwIfAborted();
						timeoutSignal?.throwIfAborted();
					},
				);
			}
		} catch (error) {
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			if (
				parentSignal?.aborted ||
				timeoutSignal?.aborted ||
				(error instanceof Error &&
					error.name === "AbortError" &&
					!attemptTimedOut &&
					timeoutSignal === undefined) ||
				attempt >= maxRetries
			) {
				throw error;
			}
		}
	}
}
