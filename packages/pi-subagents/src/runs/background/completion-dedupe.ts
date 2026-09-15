interface CompletionDataLike {
	id?: unknown;
	agent?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	state?: unknown;
	taskIndex?: unknown;
	totalTasks?: unknown;
	success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	return Number.isFinite(value) ? value : undefined;
}

export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
	const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
	const id = asNonEmptyString(data.id);
	// The codebase emits both "complete" and "completed" for the same terminal
	// condition; normalize so spelling variants of one completion share a key.
	const rawState = asNonEmptyString(data.state);
	const state = rawState === "complete" ? "completed" : rawState;
	if (id) return state
		? `session:${sessionId}:id:${id}:state:${state}`
		: `session:${sessionId}:id:${id}`;
	const agent = asNonEmptyString(data.agent) ?? "unknown";
	const timestamp = asFiniteNumber(data.timestamp);
	const taskIndex = asFiniteNumber(data.taskIndex);
	const totalTasks = asFiniteNumber(data.totalTasks);
	const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
	return [
		"meta",
		sessionId,
		agent,
		timestamp !== undefined ? String(timestamp) : "no-ts",
		taskIndex !== undefined ? String(taskIndex) : "-",
		totalTasks !== undefined ? String(totalTasks) : "-",
		success,
		fallback,
	].join(":");
}

function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
	for (const [key, ts] of seen.entries()) {
		if (now - ts > ttlMs) seen.delete(key);
	}
}

export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
	pruneSeenMap(seen, now, ttlMs);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}
