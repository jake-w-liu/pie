/**
 * Regression test: the temp file `atomicWriteFile` writes before the rename must not be
 * readable by others when the target is private. The temp file used to be created with the
 * umask default (0644) and narrowed by chmod only after the new contents were written.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tempModesAfterWrite = vi.hoisted(() => [] as number[]);

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			await actual.writeFile(...args);
			const file = args[0];
			if (typeof file === "string" && file.endsWith(".tmp")) {
				tempModesAfterWrite.push((await actual.stat(file)).mode & 0o777);
			}
		},
	};
});

const { atomicWriteFile } = await import("../../src/harness/utils/atomic-write.ts");

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-atomic-temp-mode-"));
	tempModesAfterWrite.length = 0;
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

it("keeps the temp copy of a private target owner-only while it holds the new contents", async () => {
	const previous = process.umask(0o022);
	try {
		const target = path.join(dir, "secret.env");
		await fs.writeFile(target, "OLD=1\n");
		await fs.chmod(target, 0o600);

		await atomicWriteFile(target, "SECRET=new\n");

		expect(tempModesAfterWrite).toEqual([0o600]);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(target, "utf8")).toBe("SECRET=new\n");
	} finally {
		process.umask(previous);
	}
});
