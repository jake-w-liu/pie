import { uuidv7 } from "@earendil-works/pi-ai";
import { SessionError } from "../types.ts";
import type { JsonlSessionRepoFileSystem } from "./types.ts";

/** Renew frequently enough that a transient delay does not make a healthy remote writer stale. */
export const JSONL_LEASE_RENEW_INTERVAL_MS = 5_000;
/** Four missed renewals are required before a foreign-host lease can be stolen. */
export const JSONL_LEASE_STALE_AFTER_MS = 20_000;

const OWNER_FILE = "owner.json";
const OWNER_READ_ATTEMPTS = 10;
const OWNER_READ_RETRY_MS = 25;

type LeaseOwner = {
	ownerId: string;
	pid: number;
	hostname: string;
	acquiredAt: number;
	renewedAt: number;
};

export interface JsonlWriterLease {
	readonly lockPath: string;
	assertUsable(): void;
	close(): Promise<void>;
}

class UnleasedJsonlWriter implements JsonlWriterLease {
	readonly lockPath: string;

	constructor(lockPath: string) {
		this.lockPath = lockPath;
	}

	assertUsable(): void {}
	async close(): Promise<void> {}
}

/** A read-only handle holds no claim, so every write through it must fail instead of running unlocked. */
class ReadOnlyJsonlWriter implements JsonlWriterLease {
	readonly lockPath: string;

	constructor(sessionPath: string) {
		this.lockPath = sessionPath;
	}

	assertUsable(): void {
		throw new SessionError("storage", `Session was opened read-only: ${this.lockPath}`);
	}

	async close(): Promise<void> {}
}

class ExclusiveJsonlWriterLease implements JsonlWriterLease {
	readonly lockPath: string;
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly ownerPath: string;
	private owner: LeaseOwner;
	private timer: ReturnType<typeof setInterval> | undefined;
	private renewalTail: Promise<void> = Promise.resolve();
	private renewalError: SessionError | undefined;
	private released = false;

	constructor(fs: JsonlSessionRepoFileSystem, lockPath: string, ownerPath: string, owner: LeaseOwner) {
		this.fs = fs;
		this.lockPath = lockPath;
		this.ownerPath = ownerPath;
		this.owner = owner;
		this.timer = setInterval(() => {
			this.renewalTail = this.renewalTail
				.then(() => this.renew())
				.catch((error: unknown) => {
					this.renewalError =
						error instanceof SessionError
							? error
							: new SessionError(
									"storage",
									`Failed to renew JSONL writer lease ${this.lockPath}`,
									error instanceof Error ? error : undefined,
								);
				});
		}, JSONL_LEASE_RENEW_INTERVAL_MS);
		// Only Node-style timers can be told not to hold the process open; a browser timer never does.
		if (typeof this.timer === "object") this.timer.unref();
	}

	assertUsable(): void {
		if (this.released) throw new SessionError("storage", `JSONL writer lease was released: ${this.lockPath}`);
		if (this.renewalError) throw this.renewalError;
	}

	async close(): Promise<void> {
		if (this.released) return;
		this.released = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.renewalTail;

		const current = await readOwner(this.fs, this.ownerPath);
		if (current.kind === "missing") return;
		if (current.kind === "error") throw current.error;
		if (current.owner.ownerId !== this.owner.ownerId) return;

		const ownerRemoval = await this.fs.remove(this.ownerPath, { force: true });
		if (!ownerRemoval.ok && ownerRemoval.error.code !== "not_found") {
			throw fileFailure("Failed to remove JSONL writer lease owner", this.ownerPath, ownerRemoval.error);
		}
		const lockRemoval = await this.fs.remove(this.lockPath, { recursive: true });
		if (!lockRemoval.ok && lockRemoval.error.code !== "not_found") {
			throw fileFailure("Failed to remove JSONL writer lease", this.lockPath, lockRemoval.error);
		}
	}

	private async renew(): Promise<void> {
		if (this.released) return;
		const current = await readOwner(this.fs, this.ownerPath);
		if (current.kind !== "owner" || current.owner.ownerId !== this.owner.ownerId) {
			throw new SessionError("storage", `Lost JSONL writer lease: ${this.lockPath}`);
		}
		this.owner = { ...this.owner, renewedAt: Date.now() };
		const written = await this.fs.writeFile(this.ownerPath, `${JSON.stringify(this.owner)}\n`);
		if (!written.ok) throw fileFailure("Failed to renew JSONL writer lease", this.ownerPath, written.error);
	}
}

type OwnerRead = { kind: "owner"; owner: LeaseOwner } | { kind: "missing" } | { kind: "error"; error: SessionError };

function fileFailure(operation: string, path: string, error: Error): SessionError {
	return new SessionError("storage", `${operation} ${path}: ${error.message}`, error);
}

function isLeaseOwner(value: unknown): value is LeaseOwner {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.ownerId === "string" &&
		typeof candidate.pid === "number" &&
		Number.isInteger(candidate.pid) &&
		candidate.pid > 0 &&
		typeof candidate.hostname === "string" &&
		typeof candidate.acquiredAt === "number" &&
		Number.isFinite(candidate.acquiredAt) &&
		typeof candidate.renewedAt === "number" &&
		Number.isFinite(candidate.renewedAt)
	);
}

async function readOwner(fs: JsonlSessionRepoFileSystem, ownerPath: string): Promise<OwnerRead> {
	const result = await fs.readTextFile(ownerPath);
	if (!result.ok) {
		if (result.error.code === "not_found") return { kind: "missing" };
		return { kind: "error", error: fileFailure("Failed to read JSONL writer lease owner", ownerPath, result.error) };
	}
	try {
		const parsed: unknown = JSON.parse(result.value);
		if (!isLeaseOwner(parsed)) {
			return {
				kind: "error",
				error: new SessionError("storage", `Invalid JSONL writer lease owner record: ${ownerPath}`),
			};
		}
		return { kind: "owner", owner: parsed };
	} catch (error) {
		return {
			kind: "error",
			error: new SessionError(
				"storage",
				`Invalid JSONL writer lease owner record: ${ownerPath}`,
				error instanceof Error ? error : undefined,
			),
		};
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function holderDescription(owner: LeaseOwner, now: number): string {
	const age = Math.max(0, now - owner.renewedAt);
	return `pid ${owner.pid} on ${owner.hostname} (heartbeat age ${age}ms)`;
}

/** The lock is a sibling directory so its non-recursive creation is the atomic claim primitive. */
export function jsonlWriterLockPath(sessionPath: string): string {
	return `${sessionPath}.lock`;
}

/**
 * True when the filesystem cannot create the lock directory exclusively, so writes proceed unlocked.
 */
export function isJsonlWriterLeaseDegraded(lease: JsonlWriterLease): boolean {
	return lease instanceof UnleasedJsonlWriter;
}

/** A handle that reads and never writes, so it holds no claim and refuses every mutation. */
export function readOnlyJsonlWriterLease(sessionPath: string): JsonlWriterLease {
	return new ReadOnlyJsonlWriter(sessionPath);
}

export async function acquireJsonlWriterLease(
	fs: JsonlSessionRepoFileSystem,
	sessionPath: string,
): Promise<JsonlWriterLease> {
	const lockPath = jsonlWriterLockPath(sessionPath);
	const { hostIdentity } = fs;
	const ownerPathResult = await fs.joinPath([lockPath, OWNER_FILE]);
	if (!ownerPathResult.ok)
		throw fileFailure("Failed to resolve JSONL writer lease owner", lockPath, ownerPathResult.error);
	const ownerPath = ownerPathResult.value;

	for (;;) {
		const created = await fs.createDir(lockPath, { recursive: false });
		if (created.ok) {
			const now = Date.now();
			const owner: LeaseOwner = {
				ownerId: uuidv7(),
				pid: hostIdentity.pid,
				hostname: hostIdentity.hostname,
				acquiredAt: now,
				renewedAt: now,
			};
			const written = await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
			if (!written.ok) {
				await fs.remove(lockPath, { recursive: true, force: true });
				throw fileFailure("Failed to write JSONL writer lease owner", ownerPath, written.error);
			}
			return new ExclusiveJsonlWriterLease(fs, lockPath, ownerPath, owner);
		}
		if (created.error.code === "not_supported") return new UnleasedJsonlWriter(lockPath);
		if (created.error.code !== "already_exists") {
			throw fileFailure("Failed to acquire JSONL writer lease", lockPath, created.error);
		}

		let ownerRead: OwnerRead = { kind: "missing" };
		for (let attempt = 0; attempt < OWNER_READ_ATTEMPTS; attempt++) {
			ownerRead = await readOwner(fs, ownerPath);
			if (ownerRead.kind === "owner") break;
			// The record is missing or only partially written while a concurrent acquisition publishes it.
			await delay(OWNER_READ_RETRY_MS);
		}

		const now = Date.now();
		if (ownerRead.kind === "owner") {
			const sameHostLive =
				ownerRead.owner.hostname === hostIdentity.hostname && hostIdentity.isProcessAlive(ownerRead.owner.pid);
			const heartbeatLive = now - ownerRead.owner.renewedAt <= JSONL_LEASE_STALE_AFTER_MS;
			if (sameHostLive || heartbeatLive) {
				throw new SessionError(
					"already_exists",
					`Session already has a writer: ${holderDescription(ownerRead.owner, now)}`,
				);
			}
		} else {
			// A holder publishes its owner record just after claiming the directory, so a missing or torn
			// record is normally a concurrent acquisition. A crash in that window leaves a lock that no
			// later acquisition can read, so the directory's own age is the only liveness evidence left.
			const lockInfo = await fs.fileInfo(lockPath);
			if (!lockInfo.ok) {
				if (lockInfo.error.code === "not_found") continue;
				if (ownerRead.kind === "error") throw ownerRead.error;
				throw fileFailure("Failed to inspect JSONL writer lease", lockPath, lockInfo.error);
			}
			if (now - lockInfo.value.mtimeMs <= JSONL_LEASE_STALE_AFTER_MS) {
				if (ownerRead.kind === "error") throw ownerRead.error;
				throw new SessionError("already_exists", `JSONL writer lease acquisition is in progress: ${lockPath}`);
			}
		}

		const stalePath = `${lockPath}.stale-${hostIdentity.pid}-${uuidv7()}`;
		const renamed = await fs.renameFile(lockPath, stalePath);
		if (!renamed.ok) {
			if (renamed.error.code === "not_found") continue;
			throw fileFailure("Failed to steal stale JSONL writer lease", lockPath, renamed.error);
		}
		const removed = await fs.remove(stalePath, { recursive: true, force: true });
		if (!removed.ok && removed.error.code !== "not_found") {
			throw fileFailure("Failed to remove stale JSONL writer lease", stalePath, removed.error);
		}
	}
}
