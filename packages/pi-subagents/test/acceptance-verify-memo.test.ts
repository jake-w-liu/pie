import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAcceptance } from "../src/runs/shared/acceptance.ts";
import type { ResolvedAcceptanceConfig } from "../src/shared/types.ts";

function verifiedAcceptance(verify: ResolvedAcceptanceConfig["verify"]): ResolvedAcceptanceConfig {
	return { level: "verified", explicit: true, inferredReason: [], criteria: [], evidence: [], verify, stopRules: [] };
}

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

describe("acceptance verify memoization key", () => {
	it("re-runs a memoized verify command after an untracked file changes the workspace", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "verify-memo-untracked-"));
		const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "verify-memo-artifacts-"));
		try {
			git(repo, ["init", "-q"]);
			fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n", "utf-8");
			git(repo, ["add", "tracked.txt"]);
			git(repo, ["-c", "user.email=verify@example.com", "-c", "user.name=verify", "commit", "-q", "-m", "base"]);
			const marker = path.join(repo, "FAIL_MARKER");
			fs.writeFileSync(path.join(repo, "verify.mjs"), "import { existsSync } from \"node:fs\";\nprocess.exit(existsSync(new URL(\"FAIL_MARKER\", import.meta.url).pathname) ? 1 : 0);\n", "utf-8");
			const acceptance = verifiedAcceptance([{ id: "gate", command: `${process.execPath} ${JSON.stringify(path.join(repo, "verify.mjs"))}` }]);

			const clean = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(clean.verifyRuns[0]?.status).toBe("passed");
			expect(clean.verifyRuns[0]?.memoized).toBe(false);

			// Same run id and same command: a memo hit is expected while HEAD and the
			// tracked diff are unchanged.
			const memoized = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(memoized.verifyRuns[0]?.memoized).toBe(true);

			// An untracked file leaves `git diff HEAD` byte-identical, so only the
			// untracked/ignored fingerprint can tell the workspace apart.
			fs.writeFileSync(marker, "regression\n", "utf-8");
			const afterUntracked = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(afterUntracked.verifyRuns[0]?.memoized).toBe(false);
			expect(afterUntracked.verifyRuns[0]?.status).toBe("failed");
			expect(afterUntracked.status).toBe("rejected");

			// A tracked edit still busts the key, and a new memo entry is reusable.
			fs.rmSync(marker);
			fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\nedited\n", "utf-8");
			const afterTracked = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(afterTracked.verifyRuns[0]?.memoized).toBe(false);
			expect(afterTracked.verifyRuns[0]?.status).toBe("passed");
			const reuse = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(reuse.verifyRuns[0]?.memoized).toBe(true);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(artifacts, { recursive: true, force: true });
		}
	}, 60_000);

	it("re-runs a memoized verify command after an untracked file changes only its bytes", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "verify-memo-untracked-bytes-"));
		const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "verify-memo-artifacts-"));
		try {
			git(repo, ["init", "-q"]);
			fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n", "utf-8");
			git(repo, ["add", "tracked.txt"]);
			git(repo, ["-c", "user.email=verify@example.com", "-c", "user.name=verify", "commit", "-q", "-m", "base"]);
			// An untracked verifier input: the command reads its bytes and the path never
			// changes across the mutation below.
			const input = path.join(repo, "gate-input.txt");
			fs.writeFileSync(input, "ok\n", "utf-8");
			const verifier = path.join(repo, "verify.mjs");
			fs.writeFileSync(
				verifier,
				"import { readFileSync } from \"node:fs\";\nprocess.exit(readFileSync(new URL(\"gate-input.txt\", import.meta.url).pathname, \"utf-8\").trim() === \"ok\" ? 0 : 1);\n",
				"utf-8",
			);
			const acceptance = verifiedAcceptance([{ id: "gate", command: `${process.execPath} ${JSON.stringify(verifier)}` }]);

			const clean = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(clean.verifyRuns[0]?.status).toBe("passed");
			expect(clean.verifyRuns[0]?.memoized).toBe(false);
			const memoized = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(memoized.verifyRuns[0]?.memoized).toBe(true);

			// Only the contents change: HEAD, the tracked diff and the `git status` path
			// list stay byte-identical, so a path-only fingerprint would reuse the stale
			// `passed` for a tree nobody verified.
			fs.writeFileSync(input, "fail\n", "utf-8");
			const afterEdit = await evaluateAcceptance({ acceptance, output: "", cwd: repo, reportOptional: true, artifactsDir: artifacts, runId: "run-1" });
			expect(afterEdit.verifyRuns[0]?.memoized).toBe(false);
			expect(afterEdit.verifyRuns[0]?.status).toBe("failed");
			expect(afterEdit.status).toBe("rejected");
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(artifacts, { recursive: true, force: true });
		}
	}, 60_000);
});
