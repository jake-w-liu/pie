/**
 * Regression tests: when the target cannot be replaced by rename (a busy or bind-mounted file, a sticky
 * directory), `atomicWriteFile` writes in place as a plain write would. Any other failure still leaves
 * the original intact, removes the temp file, and is reported against the target path.
 */

import type * as FsPromises from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { atomicWriteFile } from "../../src/harness/utils/atomic-write.ts";

const injected = vi.hoisted(() => ({ renameCode: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			const code = injected.renameCode;
			if (code !== undefined) {
				injected.renameCode = undefined;
				const [source, destination] = args;
				// Shaped like Node's rename errors, which report the source (here the temp file) as `path`.
				throw Object.assign(new Error(`${code}: injected, rename '${source}' -> '${destination}'`), {
					code,
					syscall: "rename",
					path: source,
					dest: destination,
				});
			}
			return actual.rename(...args);
		},
	};
});

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-atomic-fallback-"));
	injected.renameCode = undefined;
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function tempFiles(): Promise<string[]> {
	return (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

it.each(["EBUSY", "EXDEV", "EPERM"])("writes in place when renaming over the target fails with %s", async (code) => {
	const target = path.join(dir, "mounted.conf");
	await fs.writeFile(target, "original");
	await fs.chmod(target, 0o640);
	injected.renameCode = code;

	await atomicWriteFile(target, "replacement");

	expect(await fs.readFile(target, "utf-8")).toBe("replacement");
	expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
	expect(await tempFiles()).toEqual([]);
});

it("keeps the original and reports the target path when replacement fails for another reason", async () => {
	const target = path.join(dir, "guarded.txt");
	await fs.writeFile(target, "original");
	injected.renameCode = "EIO";

	// realpath, because the target is resolved through symlinks (macOS /var -> /private/var).
	await expect(atomicWriteFile(target, "replacement")).rejects.toMatchObject({
		code: "EIO",
		path: await fs.realpath(target),
	});
	expect(await fs.readFile(target, "utf-8")).toBe("original");
	expect(await tempFiles()).toEqual([]);
});
