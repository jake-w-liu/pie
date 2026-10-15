import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Command,
	encodeClientMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
	ServerMessageDecoder,
	type UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { PiServer, PiServerError } from "../src/index.ts";
import { TestServerService } from "../src/testing/index.ts";
import { createUnixServer } from "../src/transports/unix/index.ts";

const service = new TestServerService();

let server: PiServer | undefined;
let tempDirectory: string | undefined;

async function makeSocketPath(): Promise<string> {
	tempDirectory = await mkdtemp(join(tmpdir(), "pss-"));
	return join(tempDirectory, "server.sock");
}

afterEach(async () => {
	await server?.close();
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
	server = undefined;
	tempDirectory = undefined;
});

test("requires explicit listeners", () => {
	expect(() => Reflect.construct(PiServer, [service, {}])).toThrow(/listeners/);
});

test("rejects Unix socket paths that cannot fit in sockaddr_un", () => {
	expect(() => createUnixServer(service, { path: `/tmp/${"x".repeat(512)}` })).toThrow(/too long/);
});

test("rejects an overlong derived private Unix bind path", async () => {
	const maxLength = process.platform === "linux" ? 107 : 103;
	const suffixLength = Buffer.byteLength("/tmp//s");
	const path = `/tmp/${"x".repeat(maxLength - suffixLength)}/s`;
	server = createUnixServer(service, { path });

	await expect(server.start()).rejects.toThrow(/private Unix bind path.*too long/);
});

test("rejects concurrent start calls without leaking the Unix listener", async () => {
	const path = await makeSocketPath();
	server = createUnixServer(service, { path });
	const starting = server.start();
	await expect(server.start()).rejects.toThrow(/starting/);
	await starting;
	await server.close();
	expect(server.addresses[0]).toBeUndefined();
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("handshake timeout cleanup does not wait for a blocked output queue", async () => {
	class BlockedConnection implements ByteConnection {
		closed = false;
		finalChunk?: Uint8Array;

		send(): Promise<void> {
			return new Promise(() => {});
		}

		close(finalChunk?: Uint8Array): void {
			this.finalChunk = finalChunk;
			this.closed = true;
		}
	}
	const core = new PiServer(service, {
		listeners: [],
		maxFrameLength: 1024,
		handshakeTimeoutMs: 10,
	});
	const connection = new BlockedConnection();
	core.accept(connection);

	await vi.waitFor(() => expect(connection.closed).toBe(true));
	expect(connection.finalChunk).toBeInstanceOf(Uint8Array);
	const messages = new ServerMessageDecoder().push(connection.finalChunk!);
	expect(messages).toMatchObject([{ type: "hello_error", error: { code: "invalid_request" } }]);
	await core.close();
});

class MemoryConnection implements ByteConnection {
	closed = false;
	readonly messages: ServerMessage[] = [];
	private readonly decoder = new ServerMessageDecoder();

	async send(chunk: Uint8Array): Promise<void> {
		this.messages.push(...this.decoder.push(chunk));
	}

	close(finalChunk?: Uint8Array): void {
		if (finalChunk) this.messages.push(...this.decoder.push(finalChunk));
		this.closed = true;
	}
}

function setTranscriptText(service: TestServerService, text: string): void {
	const item: UserTranscriptItem = { id: "u1", role: "user", content: [{ type: "text", text }], timestamp: 1 };
	const stored = service.sessions.get("s1")!;
	stored.snapshot = { ...stored.snapshot, transcript: [item] };
}

/** Connects to a seeded session whose transcript holds `text` and requests an attach. */
async function attachToTranscriptText(text: string, maxFrameLength?: number) {
	const seeded = new TestServerService();
	seeded.seed("s1");
	setTranscriptText(seeded, text);
	const errors: Error[] = [];
	server = new PiServer(seeded, { listeners: [], maxFrameLength, onError: (error) => errors.push(error) });
	const connection = new MemoryConnection();
	const handler = server.accept(connection);
	handler.onData(encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION }));
	await vi.waitFor(() => expect(connection.messages.some((message) => message.type === "hello")).toBe(true));
	const request = (id: string, command: Command) => {
		handler.onData(encodeClientMessage({ type: "request", id, request: command }));
		// Settles on the response, or on the close that replaces an unencodable result.
		return vi.waitFor(
			() => {
				const response = connection.messages.find((message) => message.type === "response" && message.id === id);
				if (!response && !connection.closed) throw new Error(`No response to ${id} yet`);
				return response;
			},
			{ timeout: 4_000 },
		);
	};
	const attached = await request("r1", { command: "attach", sessionId: "s1" });
	return { seeded, connection, errors, attached, request };
}

test("replaces lone surrogates instead of dropping the client", async () => {
	// A transcript string cut inside a surrogate pair is a valid JS string, but CBOR
	// text must hold Unicode scalar values, so the attach response could not be encoded.
	const { connection, attached } = await attachToTranscriptText("cut \ud83d emoji");
	expect(attached).toMatchObject({
		ok: true,
		result: {
			command: "attach",
			session: { transcript: [{ content: [{ type: "text", text: "cut \ufffd emoji" }] }] },
		},
	});
	expect(connection.closed).toBe(false);
});

test("closes and detaches instead of reporting an applied command whose result cannot be encoded as failed", async () => {
	// The attach registered this connection, so an error response would leave the client
	// believing it is not attached while the server keeps the session pinned to it.
	const { seeded, connection, errors, attached } = await attachToTranscriptText("x".repeat(4_096), 2_048);
	expect(attached).toBeUndefined();
	expect(connection.closed).toBe(true);
	expect(errors.map((error) => error.message)).toContainEqual(
		expect.stringContaining("Unable to encode server protocol message"),
	);
	// Detaching the only connection releases the session runtime.
	await vi.waitFor(() => expect(seeded.latestRuntime("s1").disposeCount).toBe(1), { timeout: 4_000 });
});

test("closes and detaches instead of dropping an event that cannot be encoded", async () => {
	const { seeded, connection, errors, attached } = await attachToTranscriptText("small", 2_048);
	expect(attached).toMatchObject({ ok: true });
	// The session grows past maxFrameLength, so its session_snapshot event cannot be sent;
	// skipping it would leave the client showing the old transcript with no signal.
	setTranscriptText(seeded, "x".repeat(4_096));
	seeded.latestRuntime("s1").emitSnapshot();
	await vi.waitFor(() => expect(connection.closed).toBe(true), { timeout: 4_000 });
	expect(errors.map((error) => error.message)).toContainEqual(
		expect.stringContaining("Unable to encode server protocol message"),
	);
	await vi.waitFor(() => expect(seeded.latestRuntime("s1").disposeCount).toBe(1), { timeout: 4_000 });
});

test("answers a failed command whose error cannot be encoded with a generic error", async () => {
	const { seeded, connection, attached, request } = await attachToTranscriptText("small", 2_048);
	expect(attached).toMatchObject({ ok: true });
	seeded.openSession = async () => {
		throw new PiServerError("not_found", "x".repeat(4_096));
	};
	expect(await request("r2", { command: "attach", sessionId: "s2" })).toEqual({
		type: "response",
		id: "r2",
		ok: false,
		error: { code: "internal_error", message: "Internal server error" },
	});
	expect(connection.closed).toBe(false);
	expect(await request("r3", { command: "list" })).toMatchObject({ ok: true, result: { command: "list" } });
});

test("rejects timeout values above Node's maximum timer delay", () => {
	const unix = { path: "/tmp/pi-server-timeout-test.sock" };
	expect(() => createUnixServer(service, { path: unix.path, handshakeTimeoutMs: 2_147_483_648 })).toThrow(
		/handshakeTimeoutMs/,
	);
	expect(() => createUnixServer(service, { path: unix.path, gracefulCloseTimeoutMs: 2_147_483_648 })).toThrow(
		/gracefulCloseTimeoutMs/,
	);
});

test("rejects pending-byte limits smaller than one maximum frame", async () => {
	const path = await makeSocketPath();
	expect(() => createUnixServer(service, { path, maxFrameLength: 128, maxPendingBytes: 131 })).toThrow(
		/maxPendingBytes/,
	);
});
