import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
});
