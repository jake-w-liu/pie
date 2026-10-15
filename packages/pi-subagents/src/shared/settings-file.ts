import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireDirectoryLockSync } from "@earendil-works/pi-agent-core/node";
import {
	DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
	isRetryableFileSystemError,
	runFileSystemOperationWithRetry,
	waitForFileSystemRetry,
} from "./file-system-retry.ts";

// settings.json belongs to the coding agent (FileSettingsStorage in
// packages/coding-agent/src/core/settings-manager.ts), and this extension edits it too.
// Both must lock it and replace it the same way.

/** Take the coding agent's settings lock (shared helper: same on-disk protocol, serialized reclaim). */
function acquireSettingsLock(filePath: string): () => void {
	return acquireDirectoryLockSync(`${filePath}.lock`, { retryDelaysMs: DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS });
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
