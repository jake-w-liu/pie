export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/** Decode SSE incrementally. A CR ends a line; its optional LF may arrive in the next chunk. */
export async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let line = "";
	let skipLF = false;
	let event: string | null = null;
	let data: string[] = [];
	let raw: string[] = [];
	const flush = (): ServerSentEvent | undefined => {
		const result = event || data.length > 0 ? { event, data: data.join("\n"), raw } : undefined;
		event = null;
		data = [];
		raw = [];
		return result;
	};
	const decodeLine = (line: string): ServerSentEvent | undefined => {
		if (line === "") return flush();
		raw.push(line);
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
		return;
	};
	const onAbort = () => {
		// Cancellation can race a transport failure; cleanup must not replace that failure.
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { value, done } = await reader.read();
			if (signal?.aborted) throw new Error("Request was aborted");
			const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
			let start = 0;
			for (let index = 0; index < text.length; index++) {
				if (skipLF) {
					skipLF = false;
					if (text[index] === "\n") {
						start = index + 1;
						continue;
					}
				}
				if (text[index] !== "\r" && text[index] !== "\n") continue;
				line += text.slice(start, index);
				const message = decodeLine(line);
				line = "";
				start = index + 1;
				skipLF = text[index] === "\r";
				if (signal?.aborted) throw new Error("Request was aborted");
				if (message) yield message;
			}
			line += text.slice(start);
			if (done) break;
		}
		// Preserve support for gateways that omit the final blank line at EOF.
		if (line) decodeLine(line);
		const trailing = flush();
		if (trailing) yield trailing;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {
			// An errored transport may reject cancellation; the original read error remains authoritative.
		} finally {
			reader.releaseLock();
		}
	}
}
