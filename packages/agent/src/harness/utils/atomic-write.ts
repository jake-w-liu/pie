import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, open, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface AtomicWriteOptions {
	/** File mode for a newly created target. Defaults to the existing target's mode when it has one. */
	mode?: number;
	/** Encoding used when `data` is a string. */
	encoding?: BufferEncoding;
	/** Cancels the write. Checked before the temp file is created and honored during the write. */
	signal?: AbortSignal;
}

/** Guard against a symlink cycle while walking a link chain. */
const MAX_SYMLINK_HOPS = 32;

/**
 * Resolve the real file a write must land on, so an atomic rename never replaces a
 * symlink with a regular file.
 *
 * `realpath` resolves a chain all the way, but it fails on a *dangling* chain
 * (`a -> b -> c` where `c` does not exist yet), which an in-place write would have
 * created. So when `realpath` fails the link chain is walked by hand to a fixpoint;
 * stopping after a single hop would rename over an intermediate link and silently
 * destroy it.
 */
async function resolveTargetPath(path: string): Promise<string> {
	let current = path;
	const seen = new Set<string>([path]);
	for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
		try {
			return await realpath(current);
		} catch {
			// Not resolvable yet; fall through and follow the link manually.
		}
		let link: string;
		try {
			link = await readlink(current);
		} catch {
			return current; // not a link: this is the real target, or a new file
		}
		const next = isAbsolute(link) ? link : resolve(dirname(current), link);
		if (seen.has(next)) return current; // cycle: stop rather than loop
		seen.add(next);
		current = next;
	}
	return current;
}

/**
 * Preserve the target's existing permission bits; fall back to the default for a new
 * file. A process umask is later applied with `chmod`, never through the `mode` open
 * option, because open(2) masks the requested mode and would silently narrow it
 * (a 0755 target under umask 022 would become 0755, but 0755 under umask 077 would
 * lose its group/other bits and quietly strip executability from a shared script).
 *
 * Only the permission bits are carried over. Ownership, ACLs, and xattrs belong to
 * the old inode and are not reproduced on the replacement, which is inherent to
 * replacing a file by rename rather than truncating it. The setuid/setgid/sticky bits
 * are deliberately dropped: a write must not be able to mint a privileged file.
 */
async function resolveMode(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return undefined;
	}
}

/** Report a failure against the target the caller asked for, never the temp file. */
function retargetError(error: unknown, targetPath: string): unknown {
	if (error && typeof error === "object" && "path" in error) {
		(error as NodeJS.ErrnoException).path = targetPath;
	}
	return error;
}

/**
 * Atomically replace a file's contents: write to a temp file in the same directory,
 * fsync it, then rename over the target.
 *
 * `fs.writeFile` opens with `O_TRUNC`, which destroys the original bytes before a
 * single new byte is written. A failure partway through (disk full, `EFBIG`, an
 * interrupt) therefore leaves the target holding a truncated prefix of the new
 * content with nothing to recover from. This never truncates the target: the
 * original stays intact until the rename succeeds, and a failure leaves no temp
 * file behind.
 *
 * Durability caveat: the temp file is fsynced but its directory is not, so a power
 * loss can still lose the rename itself. This is the same guarantee the existing
 * {@link atomicWriteFileSync} provides, not a journal.
 */
export async function atomicWriteFile(
	path: string,
	data: string | Uint8Array,
	options?: AtomicWriteOptions,
): Promise<void> {
	const target = await resolveTargetPath(path);

	// rename(2) needs write permission on the *directory*, not on the file, so without
	// this check a write that an in-place open would have rejected with EACCES would
	// now succeed and overwrite a deliberately read-only file. Preserve that contract.
	if (options?.signal?.aborted) throw new Error("Operation aborted");
	try {
		await access(target, constants.W_OK);
	} catch (error) {
		// A target that does not exist yet cannot be unwritable; only a genuine
		// permission failure should abort the write.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw retargetError(error, target);
	}

	const mode = options?.mode ?? (await resolveMode(target));
	const tempPath = join(dirname(target), `.${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, data, {
			...(typeof data === "string" ? { encoding: options?.encoding ?? "utf-8" } : {}),
			...(options?.signal ? { signal: options.signal } : {}),
		});
		// Apply the mode after creation: open(2) intersects it with the umask, chmod does not.
		if (mode !== undefined) await chmod(tempPath, mode);
		const handle = await open(tempPath, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, target);
	} catch (error) {
		try {
			await unlink(tempPath);
		} catch {
			// Best effort: a stray temp file is harmless and never read back.
		}
		throw retargetError(error, target);
	}
}
