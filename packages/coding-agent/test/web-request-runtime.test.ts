import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it.each(["native", "host"])(
	"preserves Request semantics with the actual %s runtime fetch and declared transport versions",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pie-web-request-runtime-"));
		try {
			const { stdout, stderr } = await exec(
				process.execPath,
				[fileURLToPath(new URL("./fixtures/web-request-runtime.ts", import.meta.url)), mode],
				{
					env: {
						PATH: process.env.PATH,
						HOME: root,
						USERPROFILE: root,
						PI_NO_LOCAL_LLM: "1",
						PI_CODING_AGENT_DIR: root,
						PIE_CODING_AGENT_DIR: root,
						AWS_EC2_METADATA_DISABLED: "true",
					},
					timeout: 20_000,
					maxBuffer: 1024 * 1024,
				},
			);
			// Native Bun writes this exact diagnostic for our deliberately malformed
			// gzip fixture even though body consumption rejects correctly. Do not
			// discard arbitrary stderr or permit it on the npm transport path.
			if (process.versions.bun && mode === "native")
				expect(["", "Decompression error: ZlibError\n"]).toContain(stderr);
			else expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toMatchObject({
				runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
				mode,
				success: true,
				rootUndici: "8.9.0",
				webUndici: "8.10.0",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	25_000,
);
