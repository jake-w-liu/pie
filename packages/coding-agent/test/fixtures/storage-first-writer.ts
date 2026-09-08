import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import lockfile from "proper-lockfile";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

// The parent starts this process before the competing writer. Pause at the
// exact filesystem/lock boundary, not on a scheduling-dependent sleep.
const [kind, path, ready, resume, scope = "global"] = process.argv.slice(2);
function barrier(): void {
	fs.writeFileSync(ready, "ready");
	const deadline = Date.now() + 15000;
	while (!fs.existsSync(resume)) {
		if (Date.now() > deadline) throw new Error("first-writer barrier timed out");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
}

if (kind.startsWith("auth")) {
	const write = fs.writeFileSync;
	let paused = false;
	fs.writeFileSync = (file, data, options) => {
		if (file === path && data === "{}" && !paused) {
			paused = true;
			if (kind.endsWith("-open")) {
				// Exercise the actual open/write gap: hold the exclusively created
				// inode open while the competing process attempts its normal lock.
				const fd = fs.openSync(file, "wx", 0o600);
				try {
					barrier();
					return write(fd, data, options);
				} finally {
					fs.closeSync(fd);
				}
			}
			barrier();
		}
		return write(file, data, options);
	};
	syncBuiltinESMExports();
	const backend = new FileAuthStorageBackend(path);
	const update = (current: string | undefined) => ({
		result: undefined,
		next: JSON.stringify({ ...JSON.parse(current ?? "{}"), delayed: { type: "api_key", key: "second" } }),
	});
	if (kind.startsWith("auth-async")) await backend.withLockAsync(async (current) => update(current));
	else backend.withLock(update);
} else {
	const manager = SettingsManager.create(path, path);
	const lock = lockfile.lockSync;
	let paused = false;
	lockfile.lockSync = (file, options) => {
		if (!paused) {
			paused = true;
			barrier();
		}
		return lock(file, options);
	};
	if (scope === "project") manager.setProjectSkillPaths(["delayed-skill"]);
	else manager.setTheme("delayed-theme");
	await manager.flush();
	const errors = manager.drainErrors();
	if (errors.length > 0) throw errors[0].error;
}
