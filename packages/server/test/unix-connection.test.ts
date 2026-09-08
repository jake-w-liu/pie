import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { encodeServerMessage, type ServerHelloError, ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { expect, test, vi } from "vitest";
import { UnixByteConnection } from "../src/transports/unix/listener.ts";

class ControlledSocket extends EventEmitter {
	destroyed = false;
	writable = true;
	writableLength = 0;
	ended = false;
	finalChunk?: Uint8Array;
	readonly chunks: Uint8Array[] = [];
	private writeCallback?: (error?: Error | null) => void;

	write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
		this.chunks.push(chunk.slice());
		this.writableLength = 1;
		this.writeCallback = callback;
		return false;
	}

	end(chunk?: Uint8Array): this {
		this.ended = true;
		this.finalChunk = chunk?.slice();
		return this;
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.writable = false;
		this.emit("close");
		return this;
	}

	completeWrite(): void {
		const callback = this.writeCallback;
		if (!callback) throw new Error("No pending write");
		this.writeCallback = undefined;
		this.writableLength = 0;
		callback(null);
	}
}

test("queues a final protocol error behind pending output before closing", async () => {
	const socket = new ControlledSocket();
	const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
	const pendingWrite = connection.send(new Uint8Array([1, 2, 3]));
	await vi.waitFor(() => expect(socket.writableLength).toBe(1));
	const finalMessage: ServerHelloError = {
		type: "hello_error",
		error: { code: "invalid_request", message: "Protocol violation" },
	};
	const closing = connection.close(encodeServerMessage(finalMessage));

	expect(socket.ended).toBe(false);
	expect(socket.destroyed).toBe(false);

	socket.completeWrite();
	await pendingWrite;
	await vi.waitFor(() => expect(socket.ended).toBe(true));
	expect(new ServerMessageDecoder().push(socket.finalChunk!)).toEqual([finalMessage]);

	socket.destroy();
	connection.markClosed();
	await closing;
});

test.each([false, true])("drains all admitted output before close (write started: %s)", async (started) => {
	const socket = new ControlledSocket();
	const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
	socket.once("close", () => connection.markClosed());
	const first = connection.send(new Uint8Array([1]));
	if (started) await vi.waitFor(() => expect(socket.chunks).toHaveLength(1));
	const second = connection.send(new Uint8Array([2]));
	const writes = Promise.allSettled([first, second]);
	const closing = connection.close(new Uint8Array([3]));
	try {
		await expect(connection.send(new Uint8Array([4]))).rejects.toThrow(/closed/);
		await vi.waitFor(() => expect(socket.chunks).toHaveLength(1));
		expect(socket.ended).toBe(false);
		socket.completeWrite();
		await vi.waitFor(() => expect(socket.chunks).toHaveLength(2));
		expect(socket.ended).toBe(false);
		socket.completeWrite();
		expect(await writes).toEqual([
			{ status: "fulfilled", value: undefined },
			{ status: "fulfilled", value: undefined },
		]);
		await vi.waitFor(() => expect(socket.ended).toBe(true));
		expect(socket.chunks).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
		expect(socket.finalChunk).toEqual(new Uint8Array([3]));
	} finally {
		socket.destroy();
		await writes;
		await closing;
	}
});

test("rejects admitted writes if the socket actually closes while draining", async () => {
	const socket = new ControlledSocket();
	const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
	socket.once("close", () => connection.markClosed());
	const writes = Promise.allSettled([connection.send(new Uint8Array([1])), connection.send(new Uint8Array([2]))]);
	await vi.waitFor(() => expect(socket.chunks).toHaveLength(1));
	const closing = connection.close();
	socket.destroy();
	expect((await writes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
	await closing;
	expect(socket.chunks).toHaveLength(1);
});
