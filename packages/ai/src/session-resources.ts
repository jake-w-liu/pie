export type SessionResourceCleanup = (sessionId?: string) => void;

const sessionResourceCleanups = new Set<SessionResourceCleanup>();

export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	// Snapshot: a cleanup may register/unregister entries (including itself)
	// while running; those take effect on the next call, not mid-iteration.
	for (const cleanup of [...sessionResourceCleanups]) {
		try {
			cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
