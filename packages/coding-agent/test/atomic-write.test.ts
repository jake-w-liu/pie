import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFileExclusiveSync, atomicWriteFileSync } from "../src/utils/atomic-write.ts";

describe("atomic-write", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function freshDir(): string {
		dir = mkdtempSync(join(tmpdir(), "pi-atomic-write-"));
		return dir;
	}

	function tempFiles(): string[] {
		return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
	}

	it("atomically replaces existing content", () => {
		const d = freshDir();
		const target = join(d, "file.txt");
		writeFileSync(target, "original");
		atomicWriteFileSync(target, "replaced");
		expect(readFileSync(target, "utf-8")).toBe("replaced");
		expect(tempFiles()).toEqual([]);
	});

	it("creates a missing file", () => {
		const d = freshDir();
		const target = join(d, "new.txt");
		atomicWriteFileSync(target, "hello");
		expect(readFileSync(target, "utf-8")).toBe("hello");
		expect(tempFiles()).toEqual([]);
	});

	it("exclusive create writes a new file", () => {
		const d = freshDir();
		const target = join(d, "exclusive.txt");
		atomicWriteFileExclusiveSync(target, "data");
		expect(readFileSync(target, "utf-8")).toBe("data");
		expect(tempFiles()).toEqual([]);
	});

	it("exclusive create throws EEXIST and preserves the existing file", () => {
		const d = freshDir();
		const target = join(d, "taken.txt");
		writeFileSync(target, "original");
		let code: string | undefined;
		try {
			atomicWriteFileExclusiveSync(target, "clobber");
		} catch (error) {
			code = (error as NodeJS.ErrnoException).code;
		}
		expect(code).toBe("EEXIST");
		expect(readFileSync(target, "utf-8")).toBe("original");
		expect(tempFiles()).toEqual([]);
	});

	it("honors the mode option", () => {
		const d = freshDir();
		const target = join(d, "secret.txt");
		atomicWriteFileSync(target, "secret", { mode: 0o600 });
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === "win32")("keeps an existing mode that the umask would narrow", () => {
		const d = freshDir();
		const target = join(d, "settings.json");
		writeFileSync(target, "{}");
		chmodSync(target, 0o664);
		const previousUmask = process.umask(0o022);
		try {
			atomicWriteFileSync(target, '{"a":1}');
		} finally {
			process.umask(previousUmask);
		}
		expect(statSync(target).mode & 0o777).toBe(0o664);
		expect(readFileSync(target, "utf-8")).toBe('{"a":1}');
	});

	it("updates a symlink target without replacing the link or its mode", () => {
		const d = freshDir();
		const target = join(d, "settings.json");
		const link = join(d, "settings-link.json");
		writeFileSync(target, "old", { mode: 0o600 });
		symlinkSync(target, link);
		atomicWriteFileSync(link, "new");
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(readFileSync(link, "utf8")).toBe("new");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});
});
