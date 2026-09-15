import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	const release = () => {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	};
	await currentQueue;
	// The path may have been replaced (rename-swap) or repointed (symlink flip)
	// while this operation was queued. Re-resolve and forward to the current
	// key's queue instead of running in parallel with writers that registered
	// against the new target. A swap between this check and `fn()`'s open is
	// still racy (only OS-level file locking would close it).
	try {
		const freshKey = await getMutationQueueKey(filePath);
		if (freshKey !== key) {
			release();
			return withFileMutationQueue(filePath, fn);
		}
	} catch {
		// Resolution failed; fall through and run on the original queue.
	}
	try {
		return await fn();
	} finally {
		release();
	}
}
