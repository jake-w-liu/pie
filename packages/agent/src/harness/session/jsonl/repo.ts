import { uuidv7 } from "@earendil-works/pi-ai";
import { assertJsonSerializable, Session } from "../session.ts";
import { type ForkOptions, SessionError, type SessionRepo } from "../types.ts";
import { metadataFromHeader, parseHeader } from "./codec.ts";
import { fileResult } from "./errors.ts";
import { JsonlSessionStorage } from "./storage.ts";
import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoFileSystem,
	JsonlSessionRepoOptions,
	JsonlV4Header,
} from "./types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

type JsonlPathIdentity = { path: string; directory?: string };
type JsonlStorageAdmission =
	| { kind: "ready"; storage: JsonlSessionStorage }
	| { kind: "redirect"; canonical: Awaited<ReturnType<JsonlSessionRepoFileSystem["canonicalPath"]>> };

function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError(
			"invalid_payload",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

function jsonlSessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function jsonlSessionsRoot(options: JsonlSessionRepoOptions): Promise<string> {
	return fileResult(
		await options.fs.absolutePath(options.sessionsRoot),
		`Failed to resolve sessions root ${options.sessionsRoot}`,
	);
}

async function jsonlSessionDirectory(
	fs: JsonlSessionRepoFileSystem,
	sessionsRoot: string,
	cwd: string,
): Promise<string> {
	return fileResult(
		await fs.joinPath([sessionsRoot, jsonlSessionDirectoryName(cwd)]),
		`Failed to resolve sessions directory for ${cwd}`,
	);
}

async function jsonlSessionDirectories(options: JsonlSessionRepoOptions, cwd?: string): Promise<string[]> {
	const sessionsRoot = await jsonlSessionsRoot(options);
	if (cwd !== undefined) {
		const resolvedCwd = fileResult(await options.fs.absolutePath(cwd), `Failed to resolve session cwd ${cwd}`);
		const directory = await jsonlSessionDirectory(options.fs, sessionsRoot, resolvedCwd);
		return fileResult(await options.fs.exists(directory), `Failed to check sessions directory ${directory}`)
			? [directory]
			: [];
	}
	if (!fileResult(await options.fs.exists(sessionsRoot), `Failed to check sessions directory ${sessionsRoot}`))
		return [];
	return fileResult(await options.fs.listDir(sessionsRoot), `Failed to list sessions directory ${sessionsRoot}`)
		.filter((entry) => entry.kind === "directory" || entry.kind === "symlink")
		.map((entry) => entry.path);
}

export async function listJsonlSessionMetadata(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
): Promise<JsonlSessionMetadata[]> {
	const metadata: JsonlSessionMetadata[] = [];
	for (const directory of await jsonlSessionDirectories(options, query.cwd)) {
		const files = fileResult(
			await options.fs.listDir(directory),
			`Failed to list sessions directory ${directory}`,
		).filter((entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"));
		for (const file of files) {
			const [firstLine] = fileResult(
				await options.fs.readTextLines(file.path, { maxLines: 1 }),
				`Failed to read session header ${file.path}`,
			);
			if (!firstLine) continue;
			const headerResult = parseHeader(firstLine);
			if (!headerResult.ok) continue;
			const path = fileResult(await options.fs.canonicalPath(file.path), `Failed to resolve session ${file.path}`);
			metadata.push(metadataFromHeader(headerResult.value, path, file.mtimeMs));
		}
	}
	return metadata.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

export async function loadJsonlSessionStorage(
	options: JsonlSessionRepoOptions,
	metadata: JsonlSessionMetadata,
): Promise<JsonlSessionStorage> {
	if (!fileResult(await options.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
		throw new SessionError("not_found", `Session not found: ${metadata.id}`);
	}
	const storage = await JsonlSessionStorage.load(options.fs, metadata.path);
	const loadedMetadata = await storage.getMetadata();
	if (loadedMetadata.id !== metadata.id) {
		throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
	}
	return storage;
}

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
}

export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private readonly activeCreateDestinations = new Set<string>();
	private readonly liveStorages = new Map<string, WeakRef<JsonlSessionStorage>>();
	private readonly storageAccessTails = new Map<string, Promise<void>>();
	private rootPromise: Promise<string> | undefined;

	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const destination = await this.resolveCreateDestination(options);
		return this.claimCreateDestination(destination, () =>
			this.serializeStorageAccess(destination.directory, async () => {
				const { header, path } = await this.prepareCreate(destination, options);
				return this.serializeStorageAccess(path, async () => {
					await this.requireUnoccupiedDestination(path, header.id);
					const storage = await JsonlSessionStorage.create(this.fs, path, header);
					this.liveStorages.set(path, new WeakRef(storage));
					return new Session(storage);
				});
			}),
		);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		const storage = await this.loadStorage(metadata);
		return new Session(storage);
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		return this.listDirect(options);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		const addressedPath = fileResult(
			await this.fs.absolutePath(metadata.path),
			`Failed to resolve session ${metadata.path}`,
		);
		let identity = await this.resolveDeleteIdentity(addressedPath);
		for (let attempt = 0; attempt < 2; attempt++) {
			if (!identity) return;
			const admitted = identity;
			const remove = async (): Promise<JsonlPathIdentity | undefined> => {
				// The successful receipt can predate another admitted generation.
				// Revalidate before choosing a file queue or touching its owner.
				const current = await this.resolveDeleteIdentity(addressedPath);
				if (!current) return;
				if (current.directory !== admitted.directory) return current;
				await this.serializeStorageAccess(current.path, async () => {
					const storage = this.getLiveStorage(current.path);
					if (storage && (await storage.getMetadata()).path === current.path) {
						await storage.delete();
						this.forgetStorage(storage);
					} else {
						fileResult(
							await this.fs.remove(current.path, { force: true }),
							`Failed to delete session ${current.path}`,
						);
						this.liveStorages.delete(current.path);
					}
				});
			};
			// Release a changed directory before redirecting: never nest namespace queues.
			const redirect = await (admitted.directory
				? this.serializeStorageAccess(admitted.directory, remove)
				: remove());
			if (!redirect) return;
			identity = redirect;
		}
		throw new SessionError("storage", `Session identity changed during admission: ${metadata.id}`);
	}

	private async resolveDeleteIdentity(addressedPath: string): Promise<JsonlPathIdentity | undefined> {
		const canonical = await this.fs.canonicalPath(addressedPath);
		let path = canonical.ok ? canonical.value : addressedPath;
		let identity: JsonlPathIdentity | undefined;
		if (!canonical.ok) {
			const missing = canonical.error.code === "not_found" ? await this.missingTargetKind(addressedPath) : undefined;
			if (!missing) fileResult(canonical, `Failed to resolve session ${addressedPath}`);
			if (missing) {
				const selected = await this.resolveMissingStorage(addressedPath, missing);
				let known = selected.storage;
				identity = selected.identity;
				if (known) {
					const ownedPath = (await known.getMetadata()).path;
					if (
						ownedPath === addressedPath ||
						!fileResult(await this.fs.exists(ownedPath), `Failed to check session ${ownedPath}`)
					) {
						path = ownedPath;
					} else {
						// An absent retarget never authorizes deleting a healthy old owner.
						this.liveStorages.delete(addressedPath);
						known = undefined;
						if (missing === "dangling") return;
					}
				} else if (missing === "dangling") return;
				if (!known && missing === "absent") {
					identity ??= await this.resolveMissingPath(addressedPath);
					path = identity.path;
				}
			}
		}
		// The selected owner may be a validated same-parent case spelling.
		// Parent proof never substitutes its prospective key for a successful leaf.
		const parent = await this.resolveMissingPath(path);
		return { path, directory: parent.directory };
	}

	async fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const sourceStorage = await this.loadStorage(source, false);
		const createOptions = {
			...options,
			parentSessionId: options.parentSessionId ?? source.id,
		};
		const destination = await this.resolveCreateDestination(createOptions);
		return this.claimCreateDestination(destination, () =>
			this.serializeStorageAccess(destination.directory, async () => {
				const { header, path } = await this.prepareCreate(destination, createOptions);
				return this.serializeStorageAccess(path, async () => {
					await this.requireUnoccupiedDestination(path, header.id);
					const storage = await sourceStorage.fork(path, header, options);
					this.liveStorages.set(path, new WeakRef(storage));
					return new Session(storage);
				});
			}),
		);
	}

	private async loadStorage(metadata: JsonlSessionMetadata, reopenLive = true): Promise<JsonlSessionStorage> {
		const addressedPath = fileResult(
			await this.fs.absolutePath(metadata.path),
			`Failed to resolve session ${metadata.path}`,
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			const canonical = await this.fs.canonicalPath(addressedPath);
			if (!canonical.ok && canonical.error.code === "not_found") {
				await this.reopenMissingStorage(metadata, addressedPath);
			}
			// Missing/retargeted addresses never return a cached success, and real
			// resolution errors never use a lexical or prospective fallback.
			const path = fileResult(canonical, `Failed to resolve session ${addressedPath}`);
			const admission = await this.serializeStorageAccess<JsonlStorageAdmission>(path, async () => {
				const current = await this.fs.canonicalPath(addressedPath);
				if (!current.ok || current.value !== path) return { kind: "redirect", canonical: current };
				let storage = this.getLiveStorage(path);
				if (storage && (await storage.getMetadata()).path !== path) {
					this.liveStorages.delete(path);
					storage = undefined;
				}
				if (storage) {
					if ((await storage.getMetadata()).id !== metadata.id) {
						throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
					}
					if (reopenLive) await storage.reopen();
				} else {
					storage = await JsonlSessionStorage.load(this.fs, path);
				}
				if ((await storage.getMetadata()).id !== metadata.id) {
					throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
				}
				const owner = new WeakRef(storage);
				this.liveStorages.set(path, owner);
				this.liveStorages.set(addressedPath, owner);
				return { kind: "ready", storage };
			});
			if (admission.kind === "ready") return admission.storage;
			// The old file queue is released before missing-owner quarantine or
			// redirecting to a different canonical queue. Bound namespace churn.
			if (!admission.canonical.ok) {
				if (admission.canonical.error.code === "not_found") {
					await this.reopenMissingStorage(metadata, addressedPath);
				}
				fileResult(admission.canonical, `Failed to resolve session ${addressedPath}`);
			}
		}
		throw new SessionError("storage", `Session identity changed during admission: ${metadata.id}`);
	}

	private async reopenMissingStorage(metadata: JsonlSessionMetadata, addressedPath: string): Promise<void> {
		const missing = await this.missingTargetKind(addressedPath);
		if (!missing) return;
		const { storage } = await this.resolveMissingStorage(addressedPath, missing);
		if (!storage) return;
		const owned = await storage.getMetadata();
		await this.serializeStorageAccess(owned.path, async () => {
			if (owned.id !== metadata.id) {
				throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
			}
			// Existing storage alone owns quarantine/recovery of a proved writer.
			await storage.reopen();
			if (addressedPath !== owned.path) this.liveStorages.delete(addressedPath);
		});
	}

	private async resolveMissingStorage(
		addressedPath: string,
		missing: "absent" | "dangling",
	): Promise<{ storage?: JsonlSessionStorage; identity?: JsonlPathIdentity }> {
		let storage = this.getLiveStorage(addressedPath);
		let identity: JsonlPathIdentity | undefined;
		if (missing === "absent" && (!storage || (await storage.getMetadata()).path !== addressedPath)) {
			identity = await this.resolveMissingPath(addressedPath);
			const projected = this.getLiveStorage(identity.path);
			if (projected && (await projected.getMetadata()).path === identity.path) {
				storage = projected;
			} else if (storage && identity.directory) {
				const reference = await this.resolveMissingPath((await storage.getMetadata()).path);
				// Only independently differing physical parents prove retargeting.
				// Same/unknown parent retains validated leaf-case uncertainty.
				if (reference.directory && reference.directory !== identity.directory) {
					this.liveStorages.delete(addressedPath);
					storage = undefined;
				}
			}
		}
		return { storage, identity };
	}

	/** Called only after canonical resolution returned not_found. Other errors remain failures. */
	private async missingTargetKind(path: string): Promise<"absent" | "dangling" | undefined> {
		if (!fileResult(await this.fs.exists(path), `Failed to check session ${path}`)) return "absent";
		const info = await this.fs.fileInfo(path);
		if (!info.ok && info.error.code === "not_found") return "absent";
		if (fileResult(info, `Failed to inspect session ${path}`).kind !== "symlink") return undefined;
		// The alias object alone is not missing-target proof. Recheck once;
		// a present target keeps the original resolution error strict.
		const target = await this.fs.canonicalPath(path);
		if (!target.ok && target.error.code !== "not_found") {
			fileResult(target, `Failed to resolve session ${path}`);
		}
		return target.ok ? undefined : "dangling";
	}

	/** Prove a parent identity; a prospective leaf key never replaces full-file resolution. */
	private async resolveMissingPath(path: string): Promise<JsonlPathIdentity> {
		for (const separator of new Set([path.lastIndexOf("/"), path.lastIndexOf("\\")])) {
			if (separator < 0 || separator === path.length - 1) continue;
			const name = path.slice(separator + 1);
			const parent = fileResult(
				await this.fs.absolutePath(path.slice(0, separator + 1)),
				`Failed to resolve session parent ${path}`,
			);
			// The filesystem, not the separator guess, proves the decomposition.
			// A POSIX leaf can contain a literal backslash; native roots retain theirs.
			if (fileResult(await this.fs.joinPath([parent, name]), `Failed to resolve session ${path}`) !== path) continue;
			const canonical = await this.fs.canonicalPath(parent);
			if (!canonical.ok && canonical.error.code === "not_found" && (await this.missingTargetKind(parent))) {
				return { path };
			}
			const directory = fileResult(canonical, `Failed to resolve session parent ${parent}`);
			const info = fileResult(await this.fs.fileInfo(directory), `Failed to inspect session parent ${directory}`);
			if (info.kind !== "directory") {
				throw new SessionError("storage", `Session parent is not a directory: ${directory}`);
			}
			return {
				path: fileResult(await this.fs.joinPath([directory, name]), `Failed to resolve session ${path}`),
				directory,
			};
		}
		// No physical identity is inferred for an unsupported path namespace.
		return { path };
	}

	private getLiveStorage(path: string): JsonlSessionStorage | undefined {
		const reference = this.liveStorages.get(path);
		const storage = reference?.deref();
		if (reference && !storage) this.liveStorages.delete(path);
		return storage;
	}

	private forgetStorage(storage: JsonlSessionStorage): void {
		for (const [path, reference] of this.liveStorages) {
			const owner = reference.deref();
			if (!owner || owner === storage) this.liveStorages.delete(path);
		}
	}

	private async requireUnoccupiedDestination(path: string, id: string): Promise<void> {
		const known = this.getLiveStorage(path);
		if (
			(known && (await known.getMetadata()).path === path) ||
			fileResult(await this.fs.exists(path), `Failed to check session ${path}`)
		) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}
	}

	/** Serialize file publication and handle ownership; reclaim idle queue records. */
	private async serializeStorageAccess<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const preceding = this.storageAccessTails.get(path) ?? Promise.resolve();
		const result = preceding.then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.storageAccessTails.set(path, tail);
		try {
			return await result;
		} finally {
			if (this.storageAccessTails.get(path) === tail) this.storageAccessTails.delete(path);
		}
	}

	private async resolveCreateDestination(
		options: JsonlSessionCreateOptions,
	): Promise<{ id: string; cwd: string; directory: string }> {
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		const cwd = fileResult(await this.fs.absolutePath(options.cwd), `Failed to resolve session cwd ${options.cwd}`);
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const addressedDirectory = await this.sessionDirectory(cwd);
		fileResult(
			await this.fs.createDir(addressedDirectory, { recursive: true }),
			`Failed to create sessions directory`,
		);
		const directory = fileResult(
			await this.fs.canonicalPath(addressedDirectory),
			`Failed to resolve sessions directory ${addressedDirectory}`,
		);
		return { id, cwd, directory };
	}

	/**
	 * Cwd encoding and directory aliases can address one physical namespace.
	 * Reserve its id through existence checks/publication, not a timestamped filename.
	 */
	private async claimCreateDestination<T>(
		destination: { id: string; directory: string },
		operation: () => Promise<T>,
	): Promise<T> {
		const key = `${destination.directory}\0${destination.id}`;
		if (this.activeCreateDestinations.has(key)) {
			throw new SessionError("already_exists", `Session already exists: ${destination.id}`);
		}
		this.activeCreateDestinations.add(key);
		try {
			return await operation();
		} finally {
			this.activeCreateDestinations.delete(key);
		}
	}

	private async prepareCreate(
		destination: { id: string; cwd: string; directory: string },
		options: JsonlSessionCreateOptions,
	): Promise<{
		header: JsonlV4Header;
		path: string;
	}> {
		const { id, cwd, directory } = destination;
		if (await this.sessionIdExists(id, directory)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

		const createdAt = Date.now();
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt,
			cwd,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		const path = fileResult(
			await this.fs.joinPath([directory, sessionFileName(createdAt, id)]),
			`Failed to resolve path for session ${id}`,
		);
		return { header, path };
	}

	private async listDirect(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		return listJsonlSessionMetadata({ fs: this.fs, sessionsRoot: this.sessionsRootInput }, options);
	}

	private async sessionIdExists(id: string, directory: string): Promise<boolean> {
		const suffix = `_${id}.jsonl`;
		if (!fileResult(await this.fs.exists(directory), `Failed to check sessions directory ${directory}`)) return false;
		const files = fileResult(await this.fs.listDir(directory), `Failed to list sessions directory ${directory}`);
		return files.some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
	}

	private async sessionDirectory(cwd: string): Promise<string> {
		return fileResult(
			await this.fs.joinPath([await this.root(), jsonlSessionDirectoryName(cwd)]),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}
}
