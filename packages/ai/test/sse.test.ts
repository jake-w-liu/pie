import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { iterateSseMessages, type ServerSentEvent } from "../src/utils/sse.ts";

async function decode(chunks: Uint8Array[]): Promise<ServerSentEvent[]> {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const events: ServerSentEvent[] = [];
	for await (const event of iterateSseMessages(body)) events.push(event);
	expect(body.locked).toBe(false);
	return events;
}

it("decodes multiline data, comments, unknown fields, mixed newlines and EOF at every byte split", async () => {
	const bytes = new TextEncoder().encode(
		": ignored\rid: 1\r\nretry: 100\n\n" +
			": comment\nevent: update\r\nunknown: x\ndata: héllo\rdata:  world\r\n\r\n" +
			"data\ndata: final",
	);
	const expected: ServerSentEvent[] = [
		{
			event: "update",
			data: "héllo\n world",
			raw: [": comment", "event: update", "unknown: x", "data: héllo", "data:  world"],
		},
		{ event: null, data: "\nfinal", raw: ["data", "data: final"] },
	];
	for (let split = 0; split <= bytes.length; split++) {
		expect(await decode([bytes.slice(0, split), bytes.slice(split)]), `split ${split}`).toEqual(expected);
	}
	expect(await decode(Array.from(bytes, (byte) => new Uint8Array([byte])))).toEqual(expected);
});

it("cancels a pending read and removes the abort listener", async () => {
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({ cancel });
	const controller = new AbortController();
	const iterator = iterateSseMessages(body, controller.signal);
	const pending = iterator.next();
	controller.abort();
	await expect(pending).rejects.toThrow("aborted");
	expect(cancel).toHaveBeenCalledOnce();
	expect(body.locked).toBe(false);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("preserves consumer failures when reader cleanup rejects", async () => {
	const cancel = vi.fn(async () => {
		throw new Error("cleanup failed");
	});
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("data: first\n\n"));
		},
		cancel,
	});
	const signal = new AbortController().signal;
	const iterator = iterateSseMessages(body, signal);
	expect((await iterator.next()).value).toMatchObject({ data: "first" });
	const error = new Error("consumer failed");
	await expect(iterator.throw(error)).rejects.toBe(error);
	expect(cancel).toHaveBeenCalledOnce();
	expect(body.locked).toBe(false);
	expect(getEventListeners(signal, "abort")).toHaveLength(0);
});
