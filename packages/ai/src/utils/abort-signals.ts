export interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}

export interface ClearableTimeoutSignal {
	signal: AbortSignal;
	clear: () => void;
}

/**
 * An `AbortSignal.timeout` deadline that `clear()` disarms once it no longer applies,
 * e.g. after response headers arrive. The signal aborts with the timeout's reason.
 */
export function clearableTimeoutSignal(timeoutMs: number): ClearableTimeoutSignal {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(timeoutMs);
	const abort = () => controller.abort(timeout.reason);
	timeout.addEventListener("abort", abort, { once: true });
	return { signal: controller.signal, clear: () => timeout.removeEventListener("abort", abort) };
}

export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) {
		return { cleanup: () => {} };
	}
	if (activeSignals.length === 1) {
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of activeSignals) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, listener } of listeners) {
				signal.removeEventListener("abort", listener);
			}
		},
	};
}
