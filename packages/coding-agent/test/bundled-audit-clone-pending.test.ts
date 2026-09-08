import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { clearCloneCache, extractGitHub } from "../../pi-web-access/github-extract.ts";
import { deferred } from "./bundled-audit-fixtures.ts";

const fixture = vi.hoisted(() => ({
	configPath: `${process.env.TMPDIR ?? "/tmp"}/pie-pending-clone-${process.pid}-${Date.now()}.json`,
	clones: [] as Array<{ path: string; finish: () => void }>,
	sizeCheck: vi.fn(async (): Promise<number> => 1),
}));
vi.mock("../../pi-web-access/utils.ts", () => ({ getWebSearchConfigPath: () => fixture.configPath }));
vi.mock("../../pi-web-access/github-api.ts", () => ({
	checkGhAvailable: async () => true,
	checkRepoSize: fixture.sizeCheck,
	fetchViaApi: () => {
		throw new Error("Unexpected remote API access");
	},
	showGhHint: () => {},
}));
vi.mock("node:child_process", () => ({
	execFile: () => {
		throw new Error("Unexpected subprocess");
	},
	spawn: (_command: string, args: string[]) => {
		const child = new EventEmitter();
		const path = args[3]!;
		let finished = false;
		fixture.clones.push({
			path,
			finish: () => {
				if (finished) return;
				finished = true;
				mkdirSync(path, { recursive: true });
				writeFileSync(join(path, "README.md"), path);
				child.emit("close", 0);
			},
		});
		return child;
	},
}));

it("does not publish a cleared pending clone or delete its same-key replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "pie-clone-pending-"));
	writeFileSync(fixture.configPath, JSON.stringify({ githubClone: { clonePath: root } }));
	const url = "https://github.com/fixture/pending";
	try {
		const old = extractGitHub(url, undefined, true);
		const coalesced = extractGitHub(url, undefined, true);
		await vi.waitFor(() => expect(fixture.clones).toHaveLength(1));
		clearCloneCache();
		const next = extractGitHub(url, undefined, true);
		await vi.waitFor(() => expect(fixture.clones).toHaveLength(2));
		const [first, replacement] = fixture.clones;
		expect(dirname(first!.path)).not.toBe(dirname(replacement!.path));
		replacement!.finish();
		expect((await next)?.content).toContain(replacement!.path);
		first!.finish();
		expect(await old).toBeNull();
		expect(await coalesced).toBeNull();
		await vi.waitFor(() => expect(existsSync(dirname(first!.path))).toBe(false));
		expect(readFileSync(join(replacement!.path, "README.md"), "utf8")).toBe(replacement!.path);
		expect((await extractGitHub(url, undefined, true))?.content).toContain(replacement!.path);
		clearCloneCache();
		expect(existsSync(dirname(replacement!.path))).toBe(false);
	} finally {
		// Release only the fixture operations owned by this test, even on a red assertion.
		for (const clone of fixture.clones.splice(0)) clone.finish();
		clearCloneCache();
		rmSync(fixture.configPath, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

it("invalidates a size lookup that predates cache disposal", async () => {
	const root = mkdtempSync(join(tmpdir(), "pie-clone-size-pending-"));
	writeFileSync(fixture.configPath, JSON.stringify({ githubClone: { clonePath: root } }));
	const size = deferred<number>();
	fixture.sizeCheck.mockReturnValueOnce(size.promise);
	const old = extractGitHub("https://github.com/fixture/old");
	try {
		await vi.waitFor(() => expect(fixture.sizeCheck).toHaveBeenCalledOnce());
		clearCloneCache();
		const next = extractGitHub("https://github.com/fixture/new", undefined, true);
		await vi.waitFor(() => expect(fixture.clones).toHaveLength(1));
		fixture.clones[0]!.finish();
		const result = await next;
		size.resolve(1);
		expect(await old).toBeNull();
		expect(fixture.clones).toHaveLength(1);
		expect(result?.content).toContain(fixture.clones[0]!.path);
	} finally {
		size.resolve(1);
		for (const clone of fixture.clones.splice(0)) clone.finish();
		clearCloneCache();
		fixture.sizeCheck.mockClear();
		rmSync(fixture.configPath, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
