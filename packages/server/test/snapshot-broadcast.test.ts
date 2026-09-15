import { ClientMessageDecoder } from "@earendil-works/pi-protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { ByteConnection, ConnectionState } from "../src/connection.ts";
import { ServerSnapshotPublisher } from "../src/snapshots.ts";
import { TestServerService } from "../src/testing/index.ts";

const timers: Array<ReturnType<typeof setTimeout>> = [];

afterEach(() => {
	while (timers.length > 0) clearTimeout(timers.pop());
});

function readyConnection(sent: unknown[]): ConnectionState {
	const connection: ByteConnection = {
		closed: false,
		send: async (chunk: Uint8Array) => {
			sent.push(chunk);
		},
		close: async () => {},
	};
	return {
		id: "conn-test",
		connection,
		decoder: new ClientMessageDecoder({}),
		sessionIds: new Set(),
		stage: "ready",
		disconnected: false,
		handshakeComplete: true,
		handshakeTimeout: setTimeout(() => {}, 60_000),
	};
}

test("a failing fire-and-forget broadcast resolves and reports instead of rejecting", async () => {
	const service = new TestServerService();
	service.listModels = async () => {
		throw new Error("models boom");
	};
	const errors: unknown[] = [];
	const sent: unknown[] = [];
	const connections = new Set<ConnectionState>([readyConnection(sent)]);
	const publisher = new ServerSnapshotPublisher({
		serverId: "test",
		service,
		connections,
		isClosing: () => false,
		listSessions: () => service.listSessions(),
		sendMessage: async (_connection, message) => {
			sent.push(message);
			return true;
		},
		reportError: (error: unknown) => {
			errors.push(error);
		},
	});

	// Must resolve (not reject): every in-repo caller fires and forgets
	// broadcast(), so a rejection would be an unhandled rejection.
	await publisher.broadcast();
	expect(errors).toHaveLength(1);
	expect(String((errors[0] as Error)?.message ?? errors[0])).toContain("models boom");
	expect(sent).toHaveLength(0);

	// The queue survives the failure: a later broadcast still delivers.
	service.listModels = async () => [];
	await publisher.broadcast();
	expect(sent).toHaveLength(1);
	expect(publisher.currentRevision).toBe(2);
});

test("broadcast with no ready connections resolves without touching the service", async () => {
	const service = new TestServerService();
	const listModels = vi.spyOn(service, "listModels");
	const errors: unknown[] = [];
	const publisher = new ServerSnapshotPublisher({
		serverId: "test",
		service,
		connections: new Set(),
		isClosing: () => false,
		listSessions: () => service.listSessions(),
		sendMessage: async () => true,
		reportError: (error: unknown) => {
			errors.push(error);
		},
	});
	await publisher.broadcast();
	expect(errors).toHaveLength(0);
	expect(listModels).not.toHaveBeenCalled();
	expect(publisher.currentRevision).toBe(0);
});
