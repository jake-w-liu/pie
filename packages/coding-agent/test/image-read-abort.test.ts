import { describe, expect, it, vi } from "vitest";

const workerState = vi.hoisted(() => ({ posted: false, terminated: 0 }));

vi.mock("node:worker_threads", () => {
	class StalledWorker {
		once(): this {
			return this;
		}

		postMessage(): void {
			workerState.posted = true;
		}

		async terminate(): Promise<number> {
			workerState.terminated++;
			return 0;
		}
	}

	return { Worker: StalledWorker };
});

import { createReadTool } from "../src/core/tools/read.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition was not reached");
}

describe("image read cancellation", () => {
	it("terminates a stalled image worker when the read is aborted", async () => {
		workerState.posted = false;
		workerState.terminated = 0;
		const controller = new AbortController();
		const read = createReadTool("/tmp", {
			operations: {
				access: async () => {},
				readFile: async () => TINY_PNG,
				detectImageMimeType: async () => "image/png",
			},
		});

		const result = read.execute("read-abort", { path: "stalled.png" }, controller.signal);
		await waitUntil(() => workerState.posted);
		controller.abort();

		await expect(result).rejects.toThrow("Operation aborted");
		await waitUntil(() => workerState.terminated === 1);
		expect(workerState.terminated).toBe(1);
	});
});
