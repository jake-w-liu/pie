import { type SessionMutation, SessionState } from "../state.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	SessionError,
	type SessionStats,
	type SessionStorage,
} from "../types.ts";
import { encodeHeader, encodeMutation, metadataFromHeader, parseHeader, parseMutation } from "./codec.ts";
import { fileResult, invalidFile, JsonlDecodeError } from "./errors.ts";
import { acquireJsonlWriterLease, type JsonlWriterLease, readOnlyJsonlWriterLease } from "./lease.ts";
import type { JsonlSessionMetadata, JsonlSessionRepoFileSystem, JsonlV4Header } from "./types.ts";

/**
 * Build a complete sibling temporary file, then atomically rename it over the destination.
 * The populate callback must create or overwrite `tempPath` with the complete file. The
 * destination is untouched until the rename commits, so a process crash while populating
 * can leave only the ignored `.tmp` file behind.
 *
 * Rejects when population or rename fails. On rejection, temporary-file removal is
 * best-effort and the original error is preserved. Callers must serialize publications to
 * the same destination because they share its deterministic `.tmp` path.
 */
async function publishFileAtomically(
	fs: JsonlSessionRepoFileSystem,
	destinationPath: string,
	populate: (tempPath: string) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		await populate(tempPath);
		fileResult(await fs.renameFile(tempPath, destinationPath), `Failed to publish staged file ${destinationPath}`);
	} catch (error) {
		await fs.remove(tempPath, { force: true });
		throw error;
	}
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function setMutationSequence(mutation: SessionMutation, seq: number): void {
	switch (mutation.kind) {
		case "entry":
			mutation.entry.seq = seq;
			break;
		case "record":
			mutation.record.seq = seq;
			break;
		case "lane":
		case "fact":
			mutation.seq = seq;
	}
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private state = new SessionState();
	private tail: Promise<void> = Promise.resolve();
	private acknowledgedContent: string;
	/** UTF-8 byte length of `acknowledgedContent`, maintained so an append does not re-encode the whole file. */
	private acknowledgedSize: number;
	/**
	 * File mtime at which the file was last written by this writer or verified to hold exactly
	 * `acknowledgedContent`; undefined until then. While size and mtime both match, the file is unchanged.
	 */
	private acknowledgedMtimeMs: number | undefined;
	private recoveryError: SessionError | undefined;
	private deleted = false;
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private readonly lease: JsonlWriterLease;

	private constructor(
		fs: JsonlSessionRepoFileSystem,
		metadata: JsonlSessionMetadata,
		content: string,
		lease: JsonlWriterLease,
	) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
		this.acknowledgedContent = content;
		this.acknowledgedSize = byteLength(content);
		this.lease = lease;
	}

	static async create(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		header: JsonlV4Header,
		lease?: JsonlWriterLease,
	): Promise<JsonlSessionStorage> {
		const ownedLease = lease ?? (await acquireJsonlWriterLease(fs, path));
		try {
			const content = encodeHeader(header);
			fileResult(await fs.writeFile(path, content), `Failed to initialize session ${path}`);
			const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
			const storage = new JsonlSessionStorage(
				fs,
				metadataFromHeader(header, path, fileInfo.mtimeMs),
				content,
				ownedLease,
			);
			storage.acknowledgedMtimeMs = fileInfo.mtimeMs;
			return storage;
		} catch (error) {
			if (!lease) await ownedLease.close();
			throw error;
		}
	}

	/** Open an existing session for writing. Claims the exclusive writer lease unless one is supplied. */
	static async load(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		acknowledgedPrefix?: string,
		lease?: JsonlWriterLease,
	): Promise<JsonlSessionStorage> {
		const ownedLease = lease ?? (await acquireJsonlWriterLease(fs, path));
		try {
			return await JsonlSessionStorage.parse(fs, path, { lease: ownedLease, acknowledgedPrefix, repair: true });
		} catch (error) {
			if (!lease) await ownedLease.close();
			throw error;
		}
	}

	/**
	 * Open an existing session for reading. The handle holds no writer claim and never repairs the file, so
	 * any number of readers can observe a session while one writer holds its lease.
	 */
	static async read(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		return await JsonlSessionStorage.parse(fs, path, { lease: readOnlyJsonlWriterLease(path), repair: false });
	}

	/**
	 * `repair` distinguishes a writer, which may truncate an unacknowledged torn tail and terminate an
	 * unterminated tail, from a reader, which must ignore both without writing.
	 */
	private static async parse(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		options: { lease: JsonlWriterLease; acknowledgedPrefix?: string; repair: boolean },
	): Promise<JsonlSessionStorage> {
		const { acknowledgedPrefix, repair } = options;
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		// Never repair or import a replacement that removed an acknowledged write.
		// A missing final newline is the only allowed change to the accepted prefix.
		// Decode first so a complete corrupt replacement retains the precise invalid-line
		// diagnostic, but do not repair or adopt anything while the prefix differs.
		const acknowledgedPrefixChanged =
			acknowledgedPrefix !== undefined &&
			!content.startsWith(acknowledgedPrefix) &&
			content !== acknowledgedPrefix.slice(0, -1);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) {
			throw invalidFile(path, 1, new JsonlDecodeError("schema", "is missing a header"));
		}
		const headerResult = parseHeader(physicalLines[0]);
		if (!headerResult.ok) throw invalidFile(path, 1, headerResult.error);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(
			fs,
			metadataFromHeader(headerResult.value, path, fileInfo.mtimeMs),
			content,
			options.lease,
		);
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			const mutationResult = parseMutation(line);
			if (!mutationResult.ok) {
				const isTornTail = index === physicalLines.length - 1 && mutationResult.error.kind === "syntax";
				if (isTornTail) {
					if (acknowledgedPrefixChanged) {
						throw new SessionError("invalid_entry", `Acknowledged session prefix changed: ${path}`);
					}
					const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
					if (repair) {
						// Drop the unacknowledged partial append by atomically publishing the valid prefix.
						await publishFileAtomically(fs, path, async (tempPath) => {
							fileResult(await fs.writeFile(tempPath, validPrefix), `Failed to stage torn-tail repair ${path}`);
						});
					}
					storage.acknowledgedContent = validPrefix;
					storage.acknowledgedSize = byteLength(validPrefix);
					return storage;
				}
				throw invalidFile(path, index + 1, mutationResult.error);
			}
			try {
				storage.applyMutation(mutationResult.value);
			} catch (error) {
				if (error instanceof SessionError && error.code === "invalid_entry") {
					throw invalidFile(path, index + 1, error);
				}
				throw error;
			}
		}
		if (acknowledgedPrefixChanged) {
			throw new SessionError("invalid_entry", `Acknowledged session prefix changed: ${path}`);
		}
		if (repair && !content.endsWith("\n")) {
			fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
			storage.acknowledgedContent += "\n";
			storage.acknowledgedSize += byteLength("\n");
		}
		return storage;
	}

	/** Validate/replay disk under the writer queue without creating a second writer. */
	reopen(fs: JsonlSessionRepoFileSystem = this.fs): Promise<void> {
		return this.enqueue(async () => {
			try {
				this.adopt(await JsonlSessionStorage.load(fs, this.metadata.path, this.acknowledgedContent, this.lease));
			} catch (error) {
				// Once an open has observed damage, old handles cannot safely append.
				this.recoveryError =
					error instanceof SessionError
						? error
						: new SessionError(
								"storage",
								`Failed to reopen session ${this.metadata.path}`,
								error instanceof Error ? error : undefined,
							);
				throw error;
			}
		}, true);
	}

	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<JsonlSessionStorage> {
		// Snapshot under the same queue as appends; never replay/repair a live writer's file.
		const mutations = await this.enqueue(async () => this.state.createForkMutations(options));
		const destinationLease = await acquireJsonlWriterLease(this.fs, path);
		try {
			await publishFileAtomically(this.fs, path, async (tempPath) => {
				const targetStorage = await JsonlSessionStorage.create(this.fs, tempPath, header, destinationLease);
				for (const mutation of mutations) {
					await targetStorage.appendMutation(mutation);
					targetStorage.applyMutation(mutation);
				}
			});
			return await JsonlSessionStorage.load(this.fs, path, undefined, destinationLease);
		} catch (error) {
			await destinationLease.close();
			throw error;
		}
	}

	/** Remove under the writer queue, then seal mutations while retaining readable history. */
	delete(): Promise<void> {
		return this.enqueue(async () => {
			fileResult(
				await this.fs.remove(this.metadata.path, { force: true }),
				`Failed to delete session ${this.metadata.path}`,
			);
			this.deleted = true;
			await this.lease.close();
		}, true);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		const result = this.tail.then(async () => {
			if (this.closed) return;
			this.closed = true;
			await this.lease.close();
		});
		this.closePromise = result;
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	isClosed(): boolean {
		return this.closed || this.closePromise !== undefined;
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: SessionMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
			const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
			if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
				throw new SessionError(
					"storage",
					`Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
				);
			}
			const record = {
				...structuredClone(newRecord),
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TRecord;
			const mutation: SessionMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(id);
			const mutation: SessionMutation = {
				kind: "fact",
				seq: this.state.nextSequence,
				fact: "label",
				targetId: id,
				label,
			};
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	private enqueue<T>(operation: () => Promise<T>, reopening = false): Promise<T> {
		const result = this.tail.then(() => {
			if (this.deleted) throw new SessionError("not_found", `Session was deleted: ${this.metadata.id}`);
			if (this.closed) throw new SessionError("storage", `Session is closed: ${this.metadata.id}`);
			this.lease.assertUsable();
			if (this.recoveryError && !reopening) throw this.recoveryError;
			return operation();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendMutation(mutation: SessionMutation): Promise<void> {
		const path = this.metadata.path;
		await this.adoptExternalGrowth(mutation);

		const encoded = encodeMutation(mutation);
		const expectedSize = this.acknowledgedSize + byteLength(encoded);
		await this.appendEncoded(encoded);
		const info = fileResult(await this.fs.fileInfo(path), `Failed to verify session append ${path}`);
		if (info.size !== expectedSize) {
			this.recoveryError = new SessionError(
				"storage",
				`Session size changed during append; refusing whole-file repair: ${path}`,
			);
			throw this.recoveryError;
		}
		this.acknowledgedContent += encoded;
		this.acknowledgedSize = expectedSize;
		this.acknowledgedMtimeMs = info.mtimeMs;
	}

	private async adoptExternalGrowth(mutation: SessionMutation): Promise<void> {
		const path = this.metadata.path;
		const info = fileResult(await this.fs.fileInfo(path), `Failed to inspect session ${path}`);
		if (info.size === this.acknowledgedSize) {
			// Reading the whole file on every append makes appends quadratic in session size. The lease
			// excludes other writers, so an unchanged size and mtime since this writer's last write or
			// verification is accepted as unchanged; any other same-size state is compared in full.
			if (info.mtimeMs === this.acknowledgedMtimeMs) return;
			const content = fileResult(await this.fs.readTextFile(path), `Failed to verify session prefix ${path}`);
			if (content !== this.acknowledgedContent) {
				throw new SessionError("invalid_entry", `Acknowledged session prefix changed: ${path}`);
			}
			// Stat precedes the read: a change after it moves mtime and is compared in full next time.
			this.acknowledgedMtimeMs = info.mtimeMs;
			return;
		}
		const loaded = await JsonlSessionStorage.load(this.fs, path, this.acknowledgedContent, this.lease);
		this.adopt(loaded);
		this.rebaseMutation(mutation);
	}

	private rebaseMutation(mutation: SessionMutation): void {
		setMutationSequence(mutation, this.state.nextSequence);
		if (mutation.kind === "entry") {
			this.state.validateUnusedId(mutation.entry.id);
			if (mutation.lane !== undefined) mutation.entry.parentId = this.state.requireLane(mutation.lane);
		} else if (mutation.kind === "record") {
			this.state.validateUnusedId(mutation.record.id);
			this.state.requireLane(mutation.record.lane);
		}
	}

	private async appendEncoded(encoded: string): Promise<void> {
		const path = this.metadata.path;
		try {
			fileResult(
				await this.fs.appendFile(path, encoded, undefined, { flush: true }),
				`Failed to append session ${path}`,
			);
		} catch (error) {
			try {
				await this.recoverFailedAppend(encoded);
			} catch (recoveryError) {
				this.recoveryError = new SessionError(
					"storage",
					`Failed to recover append; reopen session before writing: ${path}`,
					recoveryError instanceof Error ? recoveryError : undefined,
				);
			}
			throw error;
		}
	}

	private async recoverFailedAppend(encoded: string): Promise<void> {
		const path = this.metadata.path;
		const content = fileResult(await this.fs.readTextFile(path), `Failed to inspect failed append ${path}`);
		if (!content.startsWith(this.acknowledgedContent)) {
			throw new SessionError("invalid_entry", `Acknowledged session prefix changed: ${path}`);
		}
		const suffix = content.slice(this.acknowledgedContent.length);
		if (suffix.length === 0) return;

		// A prefix (including all) of our encoded line is an unacknowledged write and
		// retains the established rollback behavior. Anything else may be a complete
		// external append and is only adopted through the validated loader.
		if (encoded.startsWith(suffix)) {
			await this.publishAcknowledgedContent(content);
			return;
		}
		this.adopt(await JsonlSessionStorage.load(this.fs, path, this.acknowledgedContent, this.lease));
	}

	private publishAcknowledgedContent(observedContent: string): Promise<void> {
		return this.publishContent(this.acknowledgedContent, "append recovery", observedContent);
	}

	private async publishContent(content: string, operation: string, expectedCurrent?: string): Promise<void> {
		const path = this.metadata.path;
		const tempPath = `${path}.tmp`;
		try {
			fileResult(await this.fs.writeFile(tempPath, content), `Failed to stage ${operation} ${path}`);
			if (expectedCurrent !== undefined) {
				const current = fileResult(await this.fs.readTextFile(path), `Failed to reverify ${operation} ${path}`);
				if (current !== expectedCurrent) {
					throw new SessionError("storage", `Session changed during ${operation}; refusing replacement: ${path}`);
				}
			}
			fileResult(await this.fs.renameFile(tempPath, path), `Failed to publish staged file ${path}`);
		} catch (error) {
			await this.fs.remove(tempPath, { force: true });
			throw error;
		}
	}

	private adopt(loaded: JsonlSessionStorage): void {
		this.state = loaded.state;
		Object.assign(this.metadata, loaded.metadata);
		this.acknowledgedContent = loaded.acknowledgedContent;
		this.acknowledgedSize = loaded.acknowledgedSize;
		this.acknowledgedMtimeMs = loaded.acknowledgedMtimeMs;
		this.recoveryError = undefined;
	}

	private applyMutation(mutation: SessionMutation): void {
		this.state.applyMutation(mutation);
	}
}
