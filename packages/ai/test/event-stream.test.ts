import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

function storageOf(stream: object): { items: unknown[]; head: number } {
	const fifo: unknown = Reflect.get(stream, "queue");
	if (typeof fifo !== "object" || fifo === null) throw new Error("Missing FIFO storage");
	const items: unknown = Reflect.get(fifo, "items");
	const head: unknown = Reflect.get(fifo, "head");
	if (!Array.isArray(items) || typeof head !== "number") throw new Error("Invalid FIFO storage");
	return { items: items as unknown[], head };
}

describe("EventStream completion and FIFO ownership", () => {
	it("publishes the terminal once and closes every other pending consumer", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 2,
			(event) => event * 10,
		);
		const consumers = Array.from({ length: 4 }, () => stream[Symbol.asyncIterator]());
		const pending = consumers.map((consumer) => consumer.next());
		stream.push(1);
		stream.push(2);
		stream.push(3);
		expect(await Promise.all(pending)).toEqual([
			{ value: 1, done: false },
			{ value: 2, done: false },
			{ value: undefined, done: true },
			{ value: undefined, done: true },
		]);
		expect(await Promise.all(consumers.map((consumer) => consumer.next()))).toEqual(
			Array.from({ length: 4 }, () => ({ value: undefined, done: true })),
		);
		expect(await stream.result()).toBe(20);
		stream.end(99);
		expect(await stream.result()).toBe(20);
		expect(await stream[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
	});

	it("retains queued order for late and concurrent consumers after terminal push", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 10_000,
			(event) => event,
		);
		for (let index = 0; index <= 10_000; index++) stream.push(index);
		const first = stream[Symbol.asyncIterator]();
		const second = stream[Symbol.asyncIterator]();
		for (let index = 0; index < 10_000; index += 2) {
			expect(await Promise.all([first.next(), second.next()])).toEqual([
				{ value: index, done: false },
				{ value: index + 1, done: false },
			]);
		}
		expect(await first.next()).toEqual({ value: 10_000, done: false });
		expect(await second.next()).toEqual({ value: undefined, done: true });
		expect(await first.next()).toEqual({ value: undefined, done: true });
		expect(await stream.result()).toBe(10_000);
	});

	it("does not mistake undefined payloads or terminal results for empty storage", async () => {
		const stream = new EventStream<number | undefined, undefined>(
			(event) => event === 1,
			() => undefined,
		);
		stream.push(undefined);
		stream.push(1);
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events).toEqual([undefined, 1]);
		expect(await stream.result()).toBeUndefined();
		const waiting = new EventStream<undefined, undefined>(
			() => true,
			() => undefined,
		);
		const consumer = waiting[Symbol.asyncIterator]();
		const next = consumer.next();
		waiting.push(undefined);
		expect(await next).toEqual({ value: undefined, done: false });
		expect(await consumer.next()).toEqual({ value: undefined, done: true });
		expect(await waiting.result()).toBeUndefined();
	});

	it("end() drains queued events and does not fabricate an omitted result", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		stream.push(1);
		stream.end();
		stream.push(2);
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events).toEqual([1]);
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		stream.end(undefined);
		await Promise.resolve();
		expect(settled).toBe(false);
		stream.end(7);
		expect(await stream.result()).toBe(7);
		stream.end(8);
		expect(await stream.result()).toBe(7);
	});

	it("explicit end(result) settles pending consumers without a fake event", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		const pending = Array.from({ length: 3 }, () => stream[Symbol.asyncIterator]().next());
		stream.end(0);
		expect(await Promise.all(pending)).toEqual(Array.from({ length: 3 }, () => ({ value: undefined, done: true })));
		expect(await stream.result()).toBe(0);
	});

	it("propagates predicate failures without closing or fabricating a result", async () => {
		const failure = new Error("predicate failed");
		const stream = new EventStream<number, number>(
			(event) => {
				if (event === 1) throw failure;
				return true;
			},
			(event) => event,
		);
		expect(() => stream.push(1)).toThrow(failure);
		stream.push(2);
		expect(await stream[Symbol.asyncIterator]().next()).toEqual({ value: 2, done: false });
		expect(await stream.result()).toBe(2);
	});

	it.each(["retry", "end"] as const)("keeps ownership after an extractor failure (%s)", async (recovery) => {
		const failure = new Error("extractor failed");
		let fails = true;
		const stream = new EventStream<number, number>(
			() => true,
			(event) => {
				if (fails) throw failure;
				return event * 10;
			},
		);
		const consumer = stream[Symbol.asyncIterator]();
		const next = consumer.next();
		let settled = false;
		void stream.result().then(() => {
			settled = true;
		});
		expect(() => stream.push(1)).toThrow(failure);
		await Promise.resolve();
		expect(settled).toBe(false);
		if (recovery === "retry") {
			fails = false;
			stream.push(2);
			expect(await next).toEqual({ value: 2, done: false });
			expect(await stream.result()).toBe(20);
		} else {
			stream.end(7);
			expect(await next).toEqual({ value: undefined, done: true });
			expect(await stream.result()).toBe(7);
		}
		expect(await consumer.next()).toEqual({ value: undefined, done: true });
	});

	it.each([1, 64, 6000])(
		"reclaims storage and payload references under continuous partial drain (backlog %s)",
		async (backlog) => {
			const stream = new EventStream<{ index: number }, number>(
				() => false,
				(event) => event.index,
			);
			for (let index = 0; index < backlog; index++) stream.push({ index });
			const consumer = stream[Symbol.asyncIterator]();
			for (let index = 0; index < 20_000; index++) {
				stream.push({ index: backlog + index });
				expect(await consumer.next()).toEqual({ value: { index }, done: false });
				if (index % 512 === 0) {
					const { items, head } = storageOf(stream);
					expect(items.length - head).toBe(backlog);
					expect(items.length).toBeLessThanOrEqual(2 * backlog + 1024);
					expect(items.slice(0, head).every((item) => item === undefined)).toBe(true);
				}
			}
			stream.end(20_000 + backlog);
			for (let index = 20_000; index < 20_000 + backlog; index++) {
				expect(await consumer.next()).toEqual({ value: { index }, done: false });
			}
			expect(await consumer.next()).toEqual({ value: undefined, done: true });
			expect(storageOf(stream)).toEqual({ items: [], head: 0 });
			expect(await stream.result()).toBe(20_000 + backlog);
		},
	);
});
