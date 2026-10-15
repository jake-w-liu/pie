import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

function createTempPath(targetPath: string): string {
	return join(dirname(targetPath), `.${randomUUID()}.tmp`);
}

function removeTempFile(tempPath: string): void {
	try {
		unlinkSync(tempPath);
	} catch {
		// Best effort: a stray temp file is harmless and never read back.
	}
}

/**
 * Atomically replace a file's contents: write to a temp file in the same
 * directory, fsync it, then rename over the target. Readers never observe a
 * truncated file, even if the process crashes mid-write.
 */
export function atomicWriteFileSync(
	targetPath: string,
	data: string | NodeJS.ArrayBufferView,
	options?: { mode?: number; encoding?: BufferEncoding },
): void {
	let writeTarget = targetPath;
	let existingMode: number | undefined;
	try {
		if (lstatSync(targetPath).isSymbolicLink()) writeTarget = realpathSync(targetPath);
		existingMode = statSync(writeTarget).mode & 0o7777;
	} catch {
		// Missing targets use the caller's mode or the process default.
	}
	const mode = options?.mode ?? existingMode;
	const tempPath = createTempPath(writeTarget);
	try {
		// Owner-only until the final mode is applied, so the new contents are never readable by others
		// through the temp file. With no mode to apply, the default mode and umask apply as they would
		// for an in-place create.
		const createMode = mode === undefined ? undefined : 0o600;
		if (typeof data === "string") {
			writeFileSync(tempPath, data, { encoding: options?.encoding ?? "utf-8", mode: createMode });
		} else {
			writeFileSync(tempPath, data, { mode: createMode });
		}
		// open(2) narrows a requested mode by the umask; chmod applies it exactly, so a replaced file
		// keeps its permissions (under umask 022 a 0664 file used to become 0644).
		if (mode !== undefined) chmodSync(tempPath, mode);
		// fsync requires a write-capable handle on Windows ("r" fails with EPERM).
		const fd = openSync(tempPath, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tempPath, writeTarget);
	} catch (error) {
		removeTempFile(tempPath);
		throw error;
	}
}

/**
 * Atomically create a new file with the given contents. Unlike
 * {@link atomicWriteFileSync} this never overwrites: when the target already
 * exists it throws an `EEXIST` error, mirroring `openSync(path, "wx")`.
 */
export function atomicWriteFileExclusiveSync(
	targetPath: string,
	data: string | NodeJS.ArrayBufferView,
	options?: { mode?: number; encoding?: BufferEncoding },
): void {
	const tempPath = createTempPath(targetPath);
	try {
		if (typeof data === "string") {
			writeFileSync(tempPath, data, { encoding: options?.encoding ?? "utf-8", mode: options?.mode });
		} else {
			writeFileSync(tempPath, data, { mode: options?.mode });
		}
		// fsync requires a write-capable handle on Windows ("r" fails with EPERM).
		const fd = openSync(tempPath, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		linkSync(tempPath, targetPath);
		removeTempFile(tempPath);
	} catch (error) {
		removeTempFile(tempPath);
		throw error;
	}
}
