import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cropMatchLine } from "../../pi-fff/src/fff-format.ts";
import { FffRuntime } from "../../pi-fff/src/fff-runtime.ts";
import { deferred } from "./bundled-audit-fixtures.ts";

const native = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ff-labs/fff-node", () => ({ FileFinder: { create: native.create } }));

const roots: string[] = [];
const runtimes: FffRuntime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	native.create.mockReset();
});

function runtimeFixture() {
	const root = mkdtempSync(join(tmpdir(), "pie-fff-audit-"));
	roots.push(root);
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.stubEnv("PIE_CODING_AGENT_DIR", root);
	const runtime = new FffRuntime(root, { projectRoot: root });
	runtimes.push(runtime);
	return runtime;
}

function finderFixture() {
	const scan = deferred<{ ok: true; value: boolean }>();
	const finder = { destroy: vi.fn(), waitForScan: vi.fn(() => scan.promise) };
	native.create.mockReturnValueOnce({ ok: true, value: finder });
	return { finder, scan };
}

describe("FFF native ownership", () => {
	it.each([false, true])("invalidates pending initialization once (old finishes first=%s)", async (oldFirst) => {
		const runtime = runtimeFixture();
		const old = finderFixture();
		const first = runtime.ensure();
		const coalesced = runtime.ensure();
		await vi.waitFor(() => expect(old.finder.waitForScan).toHaveBeenCalledOnce());
		runtime.dispose();
		runtime.dispose();
		const replacement = finderFixture();
		const next = runtime.ensure();
		await vi.waitFor(() => expect(replacement.finder.waitForScan).toHaveBeenCalledOnce());
		if (oldFirst) old.scan.resolve({ ok: true, value: true });
		else replacement.scan.resolve({ ok: true, value: true });
		await Promise.resolve();
		old.scan.resolve({ ok: true, value: true });
		replacement.scan.resolve({ ok: true, value: true });
		expect((await first).isErr()).toBe(true);
		expect((await coalesced).isErr()).toBe(true);
		expect(old.finder.destroy).toHaveBeenCalledOnce();
		expect((await next).isOk()).toBe(true);
		expect(await runtime.ensure()).toMatchObject({ value: replacement.finder });
		expect(replacement.finder.destroy).not.toHaveBeenCalled();
		runtime.dispose();
		runtime.dispose();
		expect(replacement.finder.destroy).toHaveBeenCalledOnce();
	});

	it("ignores a late scan rejection after disposing initialization", async () => {
		const runtime = runtimeFixture();
		const old = finderFixture();
		const first = runtime.ensure();
		await vi.waitFor(() => expect(old.finder.waitForScan).toHaveBeenCalledOnce());
		runtime.dispose();
		const replacement = finderFixture();
		const next = runtime.ensure();
		await vi.waitFor(() => expect(replacement.finder.waitForScan).toHaveBeenCalledOnce());
		old.scan.reject(new Error("old scan failed"));
		replacement.scan.resolve({ ok: true, value: true });
		expect((await first).isErr()).toBe(true);
		expect((await next).isOk()).toBe(true);
		expect(await runtime.ensure()).toMatchObject({ value: replacement.finder });
		expect(old.finder.destroy).toHaveBeenCalledOnce();
	});
});

describe("FFF UTF-8 match cropping", () => {
	it.each(["a", "é", "界", "😀"])("retains the token after a %s prefix", (char) => {
		const prefix = char.repeat(150);
		const line = `${prefix}needle${char.repeat(300)}`;
		const start = Buffer.byteLength(prefix);
		const result = cropMatchLine(line, [[start, start + 6]]);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toContain("needle");
		expect(Buffer.from(result.text).toString("utf8")).toBe(result.text);
	});

	it.each([0, 149, 300])("preserves multibyte matches at position %s", (offset) => {
		const prefix = "😀".repeat(offset);
		const token = "é界😀";
		const line = `${prefix}${token}${"😀".repeat(300 - offset)}`;
		const start = Buffer.byteLength(prefix);
		const result = cropMatchLine(line, [[start, start + Buffer.byteLength(token)]], 179);
		expect(result.text).toContain(token);
		expect(Buffer.from(result.text).toString("utf8")).toBe(result.text);
	});
});
