import * as fs from "node:fs/promises";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { connectUnixTestClient, Deferred, TestServerService } from "../src/testing/index.ts";
import { createUnixServer } from "../src/transports/unix/index.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, lstat: vi.fn(original.lstat) };
});

test("a losing concurrent bind never unlinks the winner's private socket", async () => {
	const root = await fs.mkdtemp(join(tmpdir(), "ps-race-"));
	const path = join(root, "server.sock");
	const servers = [0, 1].map(() => createUnixServer(new TestServerService(), { path }));
	const listen = Server.prototype.listen;
	const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
	const loserFinished = new Deferred<void>();
	const waitingBinds: Array<() => void> = [];
	vi.spyOn(Server.prototype, "listen").mockImplementation(function (
		this: Server,
		...args: Parameters<Server["listen"]>
	) {
		waitingBinds.push(() => listen.apply(this, args));
		if (waitingBinds.length === 2) for (const bind of waitingBinds) bind();
		return this;
	});
	vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
		const stats = await lstat(...args);
		if (String(args[0]).startsWith(join(root, ".p-"))) {
			// Hold the winner after listen until the losing start has fully cleaned up.
			await loserFinished.promise;
			return lstat(...args);
		}
		return stats;
	});
	try {
		const results = await Promise.allSettled(
			servers.map(async (server) => {
				try {
					await server.start();
				} catch (error) {
					loserFinished.resolve(undefined);
					throw error;
				}
			}),
		);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const client = await connectUnixTestClient(path);
		try {
			expect(await client.hello()).toMatchObject({ type: "hello" });
		} finally {
			await client.close();
		}
	} finally {
		loserFinished.resolve(undefined);
		vi.restoreAllMocks();
		await Promise.all(servers.map((server) => server.close()));
		await fs.rm(root, { recursive: true, force: true });
	}
});
