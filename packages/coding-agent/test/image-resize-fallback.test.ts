/**
 * A worker that runs but cannot use its image backend must not veto the
 * in-process path: resizeImage falls back to in-process resizing both when
 * the worker throws and when it resolves to null.
 */
import { describe, expect, it, vi } from "vitest";

const workerControl = vi.hoisted(() => ({ mode: "null" as "null" | "construct-throw" | "message-error" }));

vi.mock("node:worker_threads", () => {
	class FakeWorker {
		private handlers = new Map<string, (arg: unknown) => void>();

		constructor(_specifier: unknown) {
			if (workerControl.mode === "construct-throw") {
				throw new Error("worker spawn failed");
			}
		}

		once(event: string, callback: (arg: unknown) => void): this {
			this.handlers.set(event, callback);
			return this;
		}

		postMessage(): void {
			queueMicrotask(() => {
				if (workerControl.mode === "message-error") {
					this.handlers.get("message")?.({ error: "backend unavailable" });
					return;
				}
				this.handlers.get("message")?.({ result: null });
			});
		}

		async terminate(): Promise<number> {
			return 0;
		}
	}

	return { Worker: FakeWorker };
});

import { resizeImage } from "../src/utils/image-resize.ts";

// Small 2x2 red PNG image (base64), same fixture as image-processing.test.ts.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

describe("resizeImage worker fallback", () => {
	it("falls back to in-process resizing when the worker resolves null", async () => {
		workerControl.mode = "null";
		const result = await resizeImage(Buffer.from(TINY_PNG, "base64"), "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.data).toBe(TINY_PNG);
	});

	it("falls back to in-process resizing when the worker fails to spawn", async () => {
		workerControl.mode = "construct-throw";
		const result = await resizeImage(Buffer.from(TINY_PNG, "base64"), "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.data).toBe(TINY_PNG);
	});

	it("falls back to in-process resizing when the worker reports an error", async () => {
		workerControl.mode = "message-error";
		const result = await resizeImage(Buffer.from(TINY_PNG, "base64"), "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.data).toBe(TINY_PNG);
	});

	it("still returns null when the image genuinely cannot fit maxBytes", async () => {
		workerControl.mode = "null";
		const result = await resizeImage(Buffer.from(TINY_PNG, "base64"), "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 1,
		});

		expect(result).toBeNull();
	});
});
