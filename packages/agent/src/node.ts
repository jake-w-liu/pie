export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
// Node-only: uses node:fs, so it must stay behind the "./node" entry and out of the
// browser-facing "./index" surface.
export { type AtomicWriteOptions, atomicWriteFile } from "./harness/utils/atomic-write.ts";
export {
	acquireDirectoryLockSync,
	DIRECTORY_LOCK_STALE_MS,
	DirectoryLockBusyError,
	type DirectoryLockOptions,
} from "./harness/utils/directory-lock.ts";
export * from "./index.ts";
