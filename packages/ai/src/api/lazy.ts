import type { Api, AssistantMessage, AssistantMessageEvent, FetchFunction, Model, ProviderStreams } from "../types.ts";
import { safeJsonStringify } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

function createSetupErrorMessage(model: Model<Api>, error: unknown, signal?: AbortSignal): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: signal?.aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : safeJsonStringify(error),
		timestamp: Date.now(),
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

function pushSetupError(
	target: AssistantMessageEventStream,
	model: Model<Api>,
	error: unknown,
	signal?: AbortSignal,
): void {
	const message = createSetupErrorMessage(model, error, signal);
	target.push({ type: "error", reason: signal?.aborted ? "aborted" : "error", error: message });
	target.end(message);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	Promise.resolve()
		.then(() => {
			signal?.throwIfAborted();
			return setup();
		})
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => pushSetupError(outer, model, error, signal));

	return outer;
}

export interface OAuthRetryAttempt {
	/** Set only on the retry: the access token the first attempt was rejected with. */
	rejectedOAuthAccess?: string;
	/** Wrap the request's fetch so an HTTP 401 response is observed. */
	observeFetch(fetch: FetchFunction | undefined): FetchFunction;
}

export interface OAuthRetrySetupResult {
	events: AsyncIterable<AssistantMessageEvent>;
	/** From AuthResult.oauthAccess; undefined disables the retry. */
	oauthAccess?: string;
}

/**
 * Forwards the attempt's events, holding back leading `start` events until the first
 * non-start event decides the outcome. When `retry` accepts that event, the held
 * events are discarded and nothing from this attempt reaches the target; otherwise
 * the held events are pushed and the rest forwards like {@link forwardStream}.
 */
async function forwardStreamWithRetry(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
	retry: (event: AssistantMessageEvent) => Promise<boolean>,
): Promise<void> {
	const held: AssistantMessageEvent[] = [];
	const iterator = source[Symbol.asyncIterator]();
	let decision: AssistantMessageEvent | undefined;
	try {
		while (true) {
			const next = await iterator.next();
			if (next.done) break;
			if (next.value.type === "start") {
				held.push(next.value);
				continue;
			}
			decision = next.value;
			break;
		}
		if (decision !== undefined && (await retry(decision))) {
			return;
		}
		for (const event of held) {
			target.push(event);
		}
		if (decision !== undefined) {
			target.push(decision);
		}
		while (true) {
			const next = await iterator.next();
			if (next.done) break;
			target.push(next.value);
		}
	} finally {
		await iterator.return?.();
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * Like {@link lazyStream}, but the setup runs the request with a fetch wrapper that
 * observes HTTP 401 responses. When the first attempt's terminal error follows a 401
 * and setup reported an OAuth access token, the attempt is discarded (including its
 * `start` and `error` events) and run once more with the rejected token so auth
 * resolution can refresh it. The retry forwards normally; it is never retried itself.
 */
export function lazyStreamWithOAuthRetry(
	model: Model<Api>,
	setup: (attempt: OAuthRetryAttempt) => Promise<OAuthRetrySetupResult>,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	const createFetchObserver = () => {
		let unauthorized = false;
		const observeFetch =
			(fetch: FetchFunction | undefined): FetchFunction =>
			async (input, init) => {
				const response = await (fetch ?? globalThis.fetch)(input, init);
				if (response.status === 401) unauthorized = true;
				return response;
			};
		return { observeFetch, wasUnauthorized: () => unauthorized };
	};

	Promise.resolve()
		.then(async () => {
			const first = createFetchObserver();
			signal?.throwIfAborted();
			const attempt = await setup({ observeFetch: first.observeFetch });
			await forwardStreamWithRetry(outer, attempt.events, async (event) => {
				if (
					event.type !== "error" ||
					!first.wasUnauthorized() ||
					attempt.oauthAccess === undefined ||
					signal?.aborted
				) {
					return false;
				}
				const second = createFetchObserver();
				const retried = await setup({
					rejectedOAuthAccess: attempt.oauthAccess,
					observeFetch: second.observeFetch,
				});
				await forwardStream(outer, retried.events);
				return true;
			});
		})
		.catch((error) => pushSetupError(outer, model, error, signal));

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = await load();
					options?.signal?.throwIfAborted();
					return implementation.stream(model, context, options);
				},
				options?.signal,
			),
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = await load();
					options?.signal?.throwIfAborted();
					return implementation.streamSimple(model, context, options);
				},
				options?.signal,
			),
	};

	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = await load();
					options?.signal?.throwIfAborted();
					if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
					return implementation.fetchDeferred(model, handle, options);
				},
				options?.signal,
			);
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
