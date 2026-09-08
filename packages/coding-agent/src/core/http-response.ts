// These constructors intentionally come from Bun's public native compatibility
// module. They are never used as a network transport. Node takes the fast path.
import { Response as RuntimeResponse } from "undici";
import type { Dispatcher } from "undici/index.js";

// The npm declarations describe Node's distinct Web-stream types, while Bun's
// public shim exports its native DOM Response constructor.
const NativeResponse = RuntimeResponse as unknown as typeof Response;
type ResponseMetadata = Pick<Response, "headers" | "url" | "type" | "redirected" | "status" | "statusText">;

/** Preserve the source Headers guard without sharing public JS properties. */
function headerView(headers: Headers): Headers {
	const methods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
	let view: Headers;
	// Only the immutable header list is shared. Property writes, definitions and
	// method overrides belong to this response, just as on a native clone.
	view = new Proxy(Object.create(Object.getPrototypeOf(headers)) as Headers, {
		get(target, key, receiver) {
			if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
			const value: unknown = Reflect.get(headers, key, headers);
			if (typeof value !== "function" || key === "constructor") return value;
			const cached = methods.get(key);
			if (cached?.source === value) return cached.bound;
			const bound =
				key === "forEach"
					? (callback: Parameters<Headers["forEach"]>[0], thisArg?: unknown) => {
							headers.forEach((value, name) => {
								callback.call(thisArg, value, name, view);
							});
						}
					: value.bind(headers);
			methods.set(key, { source: value, bound });
			return bound;
		},
	});
	return view;
}

/** Native body consumption plus the unchanged network response metadata. */
class TransportResponse extends NativeResponse {
	readonly #metadata: ResponseMetadata;

	constructor(body: ReadableStream<Uint8Array> | null, metadata: ResponseMetadata) {
		super(body, { status: metadata.status, statusText: metadata.statusText, headers: metadata.headers });
		const headers = metadata.type === "default" ? this.headers : headerView(metadata.headers);
		this.#metadata = {
			headers: metadata.type === "default" ? headers : metadata.headers,
			url: metadata.url,
			type: metadata.type,
			redirected: metadata.redirected,
			status: metadata.status,
			statusText: metadata.statusText,
		};
		Object.defineProperties(this, {
			clone: { enumerable: false },
			headers: { value: headers },
			url: { value: metadata.url },
			type: { value: metadata.type },
			redirected: { value: metadata.redirected },
		});
	}

	override clone = (): TransportResponse => {
		const clone = NativeResponse.prototype.clone.call(this);
		// Real network headers are immutable and can share their guarded backing
		// list. Synthetic/default responses have mutable, independently cloned lists.
		const metadata =
			this.#metadata.type === "default" ? { ...this.#metadata, headers: new Headers(this.headers) } : this.#metadata;
		return new TransportResponse(clone.body, metadata);
	};
}

/**
 * Bun's node:stream isReadable/isDisturbed do not recognize Web streams. npm
 * Undici consequently cannot error its response stream after headers, including
 * decompression failures and abort. Observe the public request controller instead
 * and forward its real failure into a native body; keep npm's transport, decoding,
 * backpressure, Request metadata, redirects and credentials unchanged.
 *
 * This does not own/close the supplied dispatcher. Its caller retains that lease.
 */
export async function fetchWithResponseErrors(
	dispatcher: Dispatcher,
	performFetch: (dispatcher: Dispatcher) => Promise<Response>,
	signal?: AbortSignal | null,
): Promise<Response> {
	if (!process.versions.bun) return performFetch(dispatcher);

	let attempt: object | undefined;
	let failure: { reason: unknown } | undefined;
	let bodyFailure: ((reason: unknown) => void) | undefined;
	let finished = false;
	const fail = (reason: unknown) => {
		if (finished || failure) return;
		failure = { reason: signal?.aborted ? signal.reason : new TypeError("terminated", { cause: reason }) };
		bodyFailure?.(failure.reason);
	};
	const abort = () => fail(signal?.reason);
	const cleanup = () => {
		finished = true;
		bodyFailure = undefined;
		signal?.removeEventListener("abort", abort);
	};

	const observed = dispatcher.compose((dispatch) => (options, handler) => {
		const token = {};
		const controls = new WeakMap<Dispatcher.DispatchController, Dispatcher.DispatchController>();
		const observe = (controller: Dispatcher.DispatchController): Dispatcher.DispatchController => {
			// Connection failures can have no controller despite the declared type.
			if (!controller) return controller;
			let wrapped = controls.get(controller);
			if (!wrapped) {
				wrapped = new Proxy(controller, {
					get(target, key) {
						if (key === "abort") {
							return (reason: Error) => {
								if (attempt === token) fail(reason);
								target.abort(reason);
							};
						}
						const value: unknown = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
					set(target, key, value) {
						return Reflect.set(target, key, value, target);
					},
				});
				controls.set(controller, wrapped);
			}
			return wrapped;
		};
		return dispatch(options, {
			onRequestStart(controller, context: unknown) {
				attempt = token;
				failure = undefined;
				handler.onRequestStart?.(observe(controller), context);
			},
			onRequestUpgrade: (controller, status, headers, socket) =>
				handler.onRequestUpgrade?.(observe(controller), status, headers, socket),
			onResponseStart: (controller, status, headers, text) =>
				handler.onResponseStart?.(observe(controller), status, headers, text),
			onResponseData: (controller, chunk) => handler.onResponseData?.(observe(controller), chunk),
			onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(observe(controller), trailers),
			onResponseError(controller, error) {
				if (attempt === token) fail(error);
				handler.onResponseError?.(observe(controller), error);
			},
			onResponseStarted: () => handler.onResponseStarted?.(),
			onBodySent: (chunk) => handler.onBodySent?.(chunk),
			onRequestSent: () => handler.onRequestSent?.(),
		});
	});

	signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await performFetch(observed);
		// A captured native Bun fetch ignores dispatcher and already settles its
		// bodies correctly. Observe actual dispatch rather than guessing its realm.
		if (!attempt || !response.body) {
			cleanup();
			return response;
		}
		const reader = response.body.getReader();
		let settled = false;
		const releaseReader = async (reason?: unknown) => {
			try {
				await reader.cancel(reason);
			} catch {
				// A correctly errored underlying reader already rejected. Preserve the
				// originating failure; cancellation is still attempted for Bun's hang.
			} finally {
				reader.releaseLock();
			}
		};
		const body = new ReadableStream({
			// npm Fetch exposes a byte stream, including caller-supplied read buffers.
			type: "bytes",
			start(controller) {
				bodyFailure = (reason) => {
					if (settled) return;
					settled = true;
					cleanup();
					controller.error(reason);
					void releaseReader(reason);
				};
				if (failure) bodyFailure(failure.reason);
			},
			async pull(controller) {
				try {
					const chunk = await reader.read();
					if (settled) return;
					if (chunk.done) {
						reader.releaseLock();
						controller.close();
						// An empty final pull must also settle an outstanding BYOB read.
						controller.byobRequest?.respond(0);
						settled = true;
						cleanup();
					} else controller.enqueue(chunk.value);
				} catch (error) {
					bodyFailure?.(error);
				}
			},
			async cancel(reason) {
				if (settled) return;
				settled = true;
				cleanup();
				await releaseReader(reason);
			},
		});
		return new TransportResponse(body, response);
	} catch (error) {
		cleanup();
		throw error;
	}
}
