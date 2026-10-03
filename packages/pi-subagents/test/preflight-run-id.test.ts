import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveSubagentLaunchContract } from "../src/api/preflight.ts";

/**
 * `runId` and `nestedRootRunId` are interpolated straight into the artifact,
 * session, lifecycle and result paths preflight reports. An unvalidated
 * "../../escape" made preflight report success with paths that left every declared
 * root.
 */
const tempDirs: string[] = [];
function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-preflight-run-id-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("preflight rejects unsafe run identifiers", () => {
	it("refuses a runId that escapes the declared roots", async () => {
		const cwd = createTempDir();
		const result = await resolveSubagentLaunchContract({
			agent: "scout",
			cwd,
			artifactsDir: cwd,
			runId: "../../escape",
			toolNames: {},
		} as never) as { ok: boolean; code?: string; message?: string };
		expect(result.ok).toBe(false);
		expect(result.code).toBe("invalid_run_id");
		expect(JSON.stringify(result)).not.toContain('"..');
	});

	it("refuses an unsafe nestedRootRunId", async () => {
		const cwd = createTempDir();
		const result = await resolveSubagentLaunchContract({
			agent: "scout",
			cwd,
			artifactsDir: cwd,
			nestedRootRunId: "../..",
			toolNames: {},
		} as never) as { ok: boolean; code?: string };
		expect(result.ok).toBe(false);
		expect(result.code).toBe("invalid_run_id");
	});

	it("still accepts an ordinary runId", async () => {
		const cwd = createTempDir();
		const result = await resolveSubagentLaunchContract({
			agent: "scout",
			cwd,
			artifactsDir: cwd,
			runId: "run-2026-abc",
			toolNames: {},
		} as never) as { ok: boolean };
		expect(result.ok).toBe(true);
	});
});