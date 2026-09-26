/**
 * Regression tests: `atomicWriteFile` must never truncate the target in place.
 *
 * `fs.writeFile` opens with `O_TRUNC`, destroying the original bytes before any
 * new byte exists. A write that fails partway through (disk full, EFBIG, an
 * interrupt) therefore leaves the target holding a truncated prefix of the new
 * content with nothing to recover from. These tests pin the atomic behavior plus
 * the two properties a temp-file-plus-rename implementation can silently break:
 * symlink targets and permission bits.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../../src/harness/utils/atomic-write.ts";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-atomic-write-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function tempFiles(): Promise<string[]> {
	return (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

describe("atomicWriteFile", () => {
	it("preserves the target's permission bits exactly, regardless of the process umask", async () => {
		const previous = process.umask(0o077); // a hardened umask must not narrow the mode
		try {
			for (const mode of [0o755, 0o644, 0o664, 0o600]) {
				const target = path.join(dir, `mode-${mode.toString(8)}.sh`);
				await fs.writeFile(target, "original");
				// chmod, not the open mode, so the fixture really has `mode` under this umask.
				await fs.chmod(target, mode);
				expect((await fs.stat(target)).mode & 0o777).toBe(mode);
				await atomicWriteFile(target, "replacement");
				expect((await fs.stat(target)).mode & 0o777).toBe(mode);
			}
		} finally {
			process.umask(previous);
		}
	});

	it("refuses to overwrite a read-only file, as an in-place write would", async () => {
		const target = path.join(dir, "readonly.txt");
		await fs.writeFile(target, "original", { mode: 0o444 });
		// rename(2) only needs directory write permission, so without an explicit
		// check the replacement would succeed and the file would still look read-only.
		await expect(atomicWriteFile(target, "replacement")).rejects.toThrow();
		expect(await fs.readFile(target, "utf-8")).toBe("original");
		expect(await tempFiles()).toEqual([]);
	});

	it("writes through a chain of relative symlinks without destroying a link", async () => {
		const c = path.join(dir, "c.txt");
		const b = path.join(dir, "b.txt");
		const a = path.join(dir, "a.txt");
		await fs.symlink("c.txt", b);
		await fs.symlink("b.txt", a);

		await atomicWriteFile(a, "via chain");

		// The chain must survive: a single-hop resolution would rename over b.
		expect((await fs.lstat(a)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(b)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(c, "utf-8")).toBe("via chain");
	});

	it("reports a failure against the target path, not the temp file", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		const target = path.join(dir, "reported.txt");
		await fs.writeFile(target, "original");
		await fs.chmod(dir, 0o500);

		try {
			// realpath, because the target is resolved through symlinks (macOS /var -> /private/var).
			await expect(atomicWriteFile(target, "replacement")).rejects.toMatchObject({
				path: await fs.realpath(target),
			});
		} finally {
			await fs.chmod(dir, 0o700);
		}
	});

	it("honors an already-aborted signal without writing", async () => {
		const target = path.join(dir, "aborted.txt");
		await fs.writeFile(target, "original");
		const controller = new AbortController();
		controller.abort();

		await expect(atomicWriteFile(target, "replacement", { signal: controller.signal })).rejects.toThrow();
		expect(await fs.readFile(target, "utf-8")).toBe("original");
		expect(await tempFiles()).toEqual([]);
	});

	it("writes new content and leaves no temp file behind", async () => {
		const target = path.join(dir, "new.txt");
		await atomicWriteFile(target, "hello");

		expect(await fs.readFile(target, "utf-8")).toBe("hello");
		expect(await tempFiles()).toEqual([]);
	});

	it("replaces existing content", async () => {
		const target = path.join(dir, "existing.txt");
		await atomicWriteFile(target, "first");
		await atomicWriteFile(target, "second");

		expect(await fs.readFile(target, "utf-8")).toBe("second");
		expect(await tempFiles()).toEqual([]);
	});

	it("preserves the target's permission bits instead of applying the default mode", async () => {
		const target = path.join(dir, "secret.txt");
		await fs.writeFile(target, "original", { mode: 0o600 });
		await atomicWriteFile(target, "replacement");

		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	});

	it("writes through a symlink instead of replacing it with a regular file", async () => {
		const real = path.join(dir, "real.txt");
		const link = path.join(dir, "link.txt");
		await fs.writeFile(real, "original");
		await fs.symlink(real, link);

		await atomicWriteFile(link, "via symlink");

		expect(await fs.readFile(real, "utf-8")).toBe("via symlink");
		// The symlink must survive: a naive rename would replace it with a file.
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it("preserves the target when the write fails, and removes its temp file", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses directory permissions
		const target = path.join(dir, "guarded.txt");
		await fs.writeFile(target, "original", { mode: 0o600 });
		await fs.chmod(dir, 0o500); // read + execute: existing files stay readable, new ones cannot be created

		try {
			await expect(atomicWriteFile(target, "replacement")).rejects.toThrow();
			// The original content must survive the failed write.
			expect(await fs.readFile(target, "utf-8")).toBe("original");
			expect(await tempFiles()).toEqual([]);
		} finally {
			await fs.chmod(dir, 0o700);
		}
	});

	it("writes Uint8Array data unchanged", async () => {
		const target = path.join(dir, "bytes.bin");
		const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
		await atomicWriteFile(target, payload);

		expect([...(await fs.readFile(target))]).toEqual([...payload]);
	});
});
