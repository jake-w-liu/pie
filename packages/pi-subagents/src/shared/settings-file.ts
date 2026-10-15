import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
	isRetryableFileSystemError,
	runFileSystemOperationWithRetry,
	waitForFileSystemRetry,
} from "./file-system-retry.ts";

// settings.json belongs to the coding agent (FileSettingsStorage in
// packages/coding-agent/src/core/settings-manager.ts), and this extension edits it too.
// Both must lock it and replace it the same way.

/**
 * proper-lockfile's default `stale` time. The coding agent locks settings.json with
 * `lockfile.lockSync(path, { realpath: false })`, which treats a lock directory older than this
 * as abandoned; using the same threshold keeps both writers' views of a stale lock identical.
 */
const SETTINGS_LOCK_STALE_MS = 10_000;

function lockIsStale(lockPath: string): boolean {
	try {
		return Date.now() - fs.statSync(lockPath).mtimeMs > SETTINGS_LOCK_STALE_MS;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

/**
 * Take the coding agent's settings lock using proper-lockfile's on-disk protocol: an empty
 * `<file>.lock` directory on the unresolved path, created with mkdir and released or reclaimed
 * with rmdir. Keeping the directory empty is what lets either writer reclaim the other's
 * abandoned lock.
 */
function acquireSettingsLock(filePath: string): () => void {
	const lockPath = `${filePath}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			fs.mkdirSync(lockPath);
			return () => {
				try {
					fs.rmdirSync(lockPath);
				} catch (error) {
					// Already reclaimed as stale by another writer; nothing left to release.
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" && lockIsStale(lockPath)) {
				// A lock from an older pi-subagents version holds an owner record; it is stale either way.
				fs.rmSync(lockPath, { recursive: true, force: true });
				continue;
			}
			if (code !== "EEXIST" && !isRetryableFileSystemError(error)) throw error;
			const delayMs = DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt];
			if (delayMs === undefined) throw new Error(`Timed out acquiring settings lock '${lockPath}'.`, { cause: error });
			waitForFileSystemRetry(delayMs);
		}
	}
}

/**
 * Run a read-modify-write of a shared settings.json under the coding agent's settings lock.
 *
 * A private lock format does not interoperate: proper-lockfile clears a stale lock with
 * rmdir, so a lock directory that holds an owner record, left by a writer that crashed,
 * failed every later coding agent settings write with ENOTEMPTY.
 */
export function withSettingsFileLock<T>(filePath: string, operation: () => T): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const release = acquireSettingsLock(filePath);
	try {
		return operation();
	} finally {
		release();
	}
}

/**
 * Atomically replace a shared settings.json, the way the coding agent's atomicWriteFileSync
 * does: a symlinked settings.json (for example one kept in a dotfiles repository) is followed
 * and its target replaced, and the file keeps its permission bits. Renaming over the link
 * instead turns it into a regular file, leaves the target stale, and resets a 0600 file to the
 * default mode. The JSON format matches the coding agent's writer.
 */
export function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
	let targetPath = filePath;
	let mode: number | undefined;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) targetPath = fs.realpathSync(filePath);
		mode = fs.statSync(targetPath).mode & 0o7777;
	} catch (error) {
		// A missing file is created with the default mode, as an in-place create would be.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const directory = path.dirname(targetPath);
	fs.mkdirSync(directory, { recursive: true });
	const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		// Owner-only until the final mode is applied, so the new contents are never readable by
		// others through the temp file.
		fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: mode === undefined ? undefined : 0o600 });
		// open(2) narrows a requested mode by the umask; chmod restores the old mode exactly.
		if (mode !== undefined) fs.chmodSync(tempPath, mode);
		// fsync needs a write-capable handle on Windows ("r" fails with EPERM).
		const fd = fs.openSync(tempPath, "r+");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		// Windows refuses the rename while another process has the file open; retry as the
		// package's other atomic writers do.
		runFileSystemOperationWithRetry(() => fs.renameSync(tempPath, targetPath), {
			retryDelaysMs: process.platform === "win32" ? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS : [],
		});
	} catch (error) {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Report the write failure itself; a stray temp file is never read back.
		}
		throw error;
	}
}
