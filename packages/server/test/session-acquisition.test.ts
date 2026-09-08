import { ClientMessageDecoder } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import type { ConnectionState } from "../src/connection.ts";
import { PiServerError } from "../src/errors.ts";
import { LiveSessionManager } from "../src/sessions.ts";
import { Deferred, TestServerService } from "../src/testing/service.ts";

function connection(id: string): ConnectionState {
	const handshakeTimeout = setTimeout(() => {}, 0);
	clearTimeout(handshakeTimeout);
	return {
		id,
		connection: { closed: false, send: async () => {}, close: () => {} },
		decoder: new ClientMessageDecoder(),
		sessionIds: new Set(),
		stage: "ready",
		disconnected: false,
		handshakeComplete: true,
		handshakeTimeout,
	};
}

function manager(service: TestServerService): LiveSessionManager {
	return new LiveSessionManager({
		service,
		isClosing: () => false,
		sendMessage: async () => true,
		closeConnection: async () => {},
		disconnect: async () => {},
		broadcastServerSnapshot: () => {},
		reportError: () => {},
	});
}

describe("session acquisition ownership", () => {
	test.each([0, 1])("retains a shared opening when waiter %s disconnects", async (disconnectedIndex) => {
		const service = new TestServerService();
		service.seed();
		const live = manager(service);
		const releaseOpen = new Deferred<void>();
		const releaseDispose = new Deferred<void>();
		const open = service.openSession.bind(service);
		vi.spyOn(service, "openSession").mockImplementation(async (id) => {
			await releaseOpen.promise;
			const runtime = await open(id);
			const dispose = runtime.dispose.bind(runtime);
			vi.spyOn(runtime, "dispose").mockImplementation(async () => {
				await releaseDispose.promise;
				await dispose();
			});
			return runtime;
		});
		const peers = [connection("first"), connection("second")];
		const attaching = peers.map((peer) => live.executeCommand(peer, { command: "attach", sessionId: "session-1" }));
		const rejected = expect(attaching[disconnectedIndex]).rejects.toThrow(/closed/);
		peers[disconnectedIndex].disconnected = true;
		await live.disconnect(peers[disconnectedIndex]);
		releaseOpen.resolve(undefined);
		try {
			await expect(attaching[1 - disconnectedIndex]).resolves.toMatchObject({
				command: "attach",
				session: { attached: true },
			});
			const runtime = service.latestRuntime("session-1");
			expect(runtime.dispose).not.toHaveBeenCalled();
			await rejected;
			expect(service.openSession).toHaveBeenCalledTimes(1);
			await expect(
				live.executeCommand(peers[1 - disconnectedIndex], {
					command: "set_thinking",
					sessionId: "session-1",
					thinkingLevel: "high",
				}),
			).resolves.toMatchObject({ session: { thinkingLevel: "high" } });
			const detached = live.executeCommand(peers[1 - disconnectedIndex], {
				command: "detach",
				sessionId: "session-1",
			});
			await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledTimes(1));
			releaseDispose.resolve(undefined);
			await detached;
			expect(runtime.disposeCount).toBe(1);
		} finally {
			releaseOpen.resolve(undefined);
			releaseDispose.resolve(undefined);
			await Promise.allSettled(attaching);
			await rejected;
			await live.close();
		}
	});

	test("disposes an opening after all waiters disconnect", async () => {
		const service = new TestServerService();
		service.seed();
		const live = manager(service);
		const release = new Deferred<void>();
		const open = service.openSession.bind(service);
		vi.spyOn(service, "openSession").mockImplementation(async (id) => {
			await release.promise;
			return open(id);
		});
		const peers = [connection("first"), connection("second")];
		const attaching = Promise.allSettled(
			peers.map((peer) => live.executeCommand(peer, { command: "attach", sessionId: "session-1" })),
		);
		for (const peer of peers) {
			peer.disconnected = true;
			await live.disconnect(peer);
		}
		release.resolve(undefined);
		expect((await attaching).map((result) => result.status)).toEqual(["rejected", "rejected"]);
		await service.latestRuntime("session-1").disposed.promise;
		expect(service.latestRuntime("session-1").disposeCount).toBe(1);
		await live.close();
	});

	test("rejects a runtime that terminates before attachment", async () => {
		const service = new TestServerService();
		service.seed();
		const runtime = await service.openSession("session-1");
		const subscribe = runtime.subscribe.bind(runtime);
		vi.spyOn(runtime, "subscribe").mockImplementation((listener) => {
			const unsubscribe = subscribe(listener);
			listener({ type: "error", error: new PiServerError("session_locked", "Terminating") });
			return unsubscribe;
		});
		vi.spyOn(service, "openSession").mockResolvedValue(runtime);
		const live = manager(service);
		const peer = connection("first");
		try {
			await expect(live.executeCommand(peer, { command: "attach", sessionId: "session-1" })).rejects.toMatchObject({
				code: "session_locked",
			});
			expect(peer.sessionIds.size).toBe(0);
			await service.latestRuntime("session-1").disposed.promise;
		} finally {
			await live.close();
		}
	});
});
