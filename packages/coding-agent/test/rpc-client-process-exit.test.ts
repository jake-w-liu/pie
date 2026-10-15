import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test.each(["waitForIdle", "collectEvents"] as const)(
		"rejects %s promptly and removes its event listener when the child exits",
		async (method) => {
			const client = new RpcClient({
				cliPath: writeChildScript(`
setTimeout(() => process.exit(43), 150);
process.stdin.resume();
`),
			});
			await client.start();

			const started = process.hrtime.bigint();
			await expect(client[method](5_000)).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
			const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

			expect(elapsedMs).toBeLessThan(1_000);
			expect((client as unknown as { eventListeners: unknown[] }).eventListeners).toHaveLength(0);
			await client.stop();
		},
		10_000,
	);

	test("stop() returns immediately when the child already exited", async () => {
		// The exit listener is registered after the kill, so a child that died
		// earlier (crash, external kill) never fires it and stop() used to burn
		// its full one-second timeout on every shutdown after a crash.
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();
		await expect(client.getCommands()).rejects.toThrow(/Agent process exited/);

		const started = process.hrtime.bigint();
		await client.stop();
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

		expect(elapsedMs).toBeLessThan(250);
	}, 10_000);

	test("keeps only recent child stderr", async () => {
		// The client mirrors child stderr to this process; keep the test output clean.
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stderr.write("x".repeat(300 * 1024));
process.stderr.write("END\\n");
process.stdin.resume();
`),
		});

		await client.start();
		try {
			await expect.poll(() => client.getStderr().endsWith("END\n"), { timeout: 10_000 }).toBe(true);
			expect(client.getStderr().length).toBeLessThanOrEqual(64 * 1024);
		} finally {
			await client.stop();
		}
	}, 20_000);
});
