import { mkdirSync, rmdirSync, rmSync, statSync } from "node:fs";

/**
 * proper-lockfile's default `stale` time. Writers that still lock the same path with
 * proper-lockfile (older Pie versions) treat a lock directory older than this as abandoned, so
 * using the same threshold keeps every writer's view of a stale lock identical.
 */
export const DIRECTORY_LOCK_STALE_MS = 10_000;

export interface DirectoryLockOptions {
	/** Age after which an existing lock directory counts as abandoned. */
	staleMs?: number;
	/** Delays between attempts while a live lock is held; running off the end fails. */
	retryDelaysMs: readonly number[];
}

/** Thrown when the lock stays held by another writer for the whole retry schedule. */
export class DirectoryLockBusyError extends Error {
	readonly code = "ELOCKED";
	readonly lockPath: string;

	constructor(lockPath: string) {
		super(`Lock is held by another writer: ${lockPath}`);
		this.name = "DirectoryLockBusyError";
		this.lockPath = lockPath;
	}
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
	// Blocks without spinning; inherent to a synchronous lock API.
	if (ms > 0) Atomics.wait(sleepBuffer, 0, 0, ms);
}

/** Age-based staleness; a missing directory is not stale (there is nothing to reclaim). */
function isStale(path: string, staleMs: number): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs > staleMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Remove an abandoned lock. Two writers that both saw the same stale lock must not both remove
 * it: the second removal would delete the lock the first one just acquired. So only the holder
 * of `<lock>.reclaim` removes, and it re-checks staleness inside that critical section.
 *
 * The reclaim mutex is held for microseconds. If its holder crashed inside that window, the
 * mutex itself goes stale and is removed with rmdir, which only succeeds on the empty directory
 * it always is.
 */
function reclaimStaleLock(lockPath: string, staleMs: number): boolean {
	const mutexPath = `${lockPath}.reclaim`;
	try {
		mkdirSync(mutexPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (isStale(mutexPath, staleMs)) {
			try {
				rmdirSync(mutexPath);
			} catch (removeError) {
				if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
			}
		}
		return false; // Another writer is reclaiming; the caller waits and retries.
	}
	// Report the first failure: a reclaim error takes precedence over a mutex-release error.
	let failure: unknown;
	try {
		// A lock from an older pi-subagents version may hold an owner record, hence recursive.
		if (isStale(lockPath, staleMs)) rmSync(lockPath, { recursive: true, force: true });
	} catch (error) {
		failure = error;
	}
	try {
		rmdirSync(mutexPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined) failure = error;
	}
	if (failure !== undefined) throw failure;
	return true;
}

/**
 * Acquire a lock directory synchronously, using proper-lockfile's on-disk protocol (an empty
 * directory created with mkdir and removed with rmdir), so it interoperates with writers that
 * use proper-lockfile on the same path. Returns the release function.
 */
export function acquireDirectoryLockSync(lockPath: string, options: DirectoryLockOptions): () => void {
	const staleMs = options.staleMs ?? DIRECTORY_LOCK_STALE_MS;
	let waits = 0;
	let reclaims = 0;
	for (;;) {
		try {
			mkdirSync(lockPath);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				try {
					rmdirSync(lockPath);
				} catch (error) {
					// Already reclaimed as stale by another writer; nothing left to release.
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		// After a completed reclaim, retry at once; otherwise (live lock, or another writer is
		// reclaiming) wait per the schedule, so a stuck reclaim never spins.
		// Each reclaim removes the stale lock, so a further one is only needed if another writer
		// abandoned a lock again; bound them by the schedule so this can never loop forever.
		if (
			isStale(lockPath, staleMs) &&
			reclaims <= options.retryDelaysMs.length &&
			reclaimStaleLock(lockPath, staleMs)
		) {
			reclaims++;
			continue;
		}
		const delayMs = options.retryDelaysMs[waits];
		if (delayMs === undefined) throw new DirectoryLockBusyError(lockPath);
		waits++;
		sleepSync(delayMs);
	}
}
