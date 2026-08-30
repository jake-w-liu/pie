import type { JsonValue, SessionSnapshot, TranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";

export interface TranscriptState {
	readonly snapshot: SessionSnapshot;
	readonly progressItems: ReadonlyMap<string, TranscriptItem>;
	readonly progressOrder: readonly string[];
	readonly toolCallBuffers: ReadonlyMap<string, string>;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return Object.values(value).every(isJsonValue);
}

function parsePartialToolInput(value: string): JsonValue {
	try {
		const parsed: unknown = JSON.parse(value);
		if (isJsonValue(parsed)) return parsed;
	} catch {
		// Tool arguments are incomplete while streaming. Preserve their raw prefix until they form valid JSON.
	}
	return value;
}

export function createTranscriptState(snapshot: SessionSnapshot): TranscriptState {
	return {
		snapshot: structuredClone(snapshot),
		progressItems: new Map(),
		progressOrder: [],
		toolCallBuffers: new Map(),
	};
}

export function applyTranscriptSnapshot(state: TranscriptState, snapshot: SessionSnapshot): TranscriptState {
	if (state.snapshot.id === snapshot.id && snapshot.revision < state.snapshot.revision) return state;
	return createTranscriptState(snapshot);
}

export function applyTranscriptProgress(state: TranscriptState, progress: TranscriptProgress): TranscriptState {
	if (progress.type === "item_started" || progress.type === "item_updated") {
		// An item_updated can replace an item's tool-call input. If it carries a
		// non-null string input, re-seed that part's delta buffer so subsequent
		// toolCall deltas build on the replaced input instead of the stale
		// pre-update prefix (which corrupted the parsed tool input). A null input
		// means the streaming delta buffer still holds the real content, so keep it.
		if (progress.type === "item_updated") {
			const toolCallBuffers = new Map(state.toolCallBuffers);
			progress.item.content.forEach((part, index) => {
				if (part.type === "toolCall" && typeof part.input === "string") {
					toolCallBuffers.set(`${progress.item.id}:${index}`, part.input);
				}
			});
			return setProgressItem({ ...state, toolCallBuffers }, progress.item);
		}
		return setProgressItem(state, progress.item);
	}
	if (progress.type === "item_finished") {
		const toolCallBuffers = new Map(state.toolCallBuffers);
		for (const key of toolCallBuffers.keys()) {
			if (key.startsWith(`${progress.item.id}:`)) toolCallBuffers.delete(key);
		}
		return setProgressItem({ ...state, toolCallBuffers }, progress.item);
	}

	const item =
		state.progressItems.get(progress.messageId) ??
		state.snapshot.transcript.find(({ id }) => id === progress.messageId);
	if (!item || item.role !== "assistant") return state;
	let toolCallBuffers = state.toolCallBuffers;
	const content = item.content.map((part, index) => {
		if (index !== progress.contentIndex) return structuredClone(part);
		if (progress.kind === "text" && part.type === "text") return { ...part, text: part.text + progress.delta };
		if (progress.kind === "thinking" && part.type === "thinking") {
			return { ...part, thinking: part.thinking + progress.delta };
		}
		if (progress.kind === "toolCall" && part.type === "toolCall") {
			const key = `${progress.messageId}:${progress.contentIndex}`;
			const existing = state.toolCallBuffers.get(key) ?? (typeof part.input === "string" ? part.input : "");
			const buffer = existing + progress.delta;
			toolCallBuffers = new Map(state.toolCallBuffers).set(key, buffer);
			return { ...part, input: parsePartialToolInput(buffer) };
		}
		return structuredClone(part);
	});
	return setProgressItem({ ...state, toolCallBuffers }, { ...item, content });
}

export function selectTranscript(state: TranscriptState): readonly TranscriptItem[] {
	const transcript = state.snapshot.transcript.map((item) => state.progressItems.get(item.id) ?? item);
	const ids = new Set(transcript.map((item) => item.id));
	for (const id of state.progressOrder) {
		if (ids.has(id)) continue;
		const item = state.progressItems.get(id);
		if (item) {
			transcript.push(item);
			ids.add(id);
		}
	}
	for (const item of state.snapshot.queuedSteer) {
		if (ids.has(item.id)) continue;
		transcript.push(item);
		ids.add(item.id);
	}
	return transcript;
}

function setProgressItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
	const progressItems = new Map(state.progressItems);
	const progressOrder = progressItems.has(item.id) ? state.progressOrder : [...state.progressOrder, item.id];
	progressItems.set(item.id, structuredClone(item));
	return { ...state, progressItems, progressOrder };
}
