/**
 * When the image backend itself is unavailable, processImage must say so
 * instead of blaming the inline image size limit.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/photon.ts", () => ({
	loadPhoton: async () => null,
}));

// Force the in-process resize path: a real worker thread would load the real
// backend outside this file's module mocks and succeed, hiding the outage.
vi.mock("node:worker_threads", () => {
	class UnavailableWorker {
		constructor(_specifier: unknown) {
			throw new Error("worker spawn failed");
		}
	}

	return { Worker: UnavailableWorker };
});

import { processImage } from "../src/utils/image-process.ts";

// Small 2x2 red PNG image (base64), same fixture as image-processing.test.ts.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

describe("processImage without an image backend", () => {
	it("reports an unavailable engine instead of the size limit", async () => {
		const result = await processImage(Buffer.from(TINY_PNG, "base64"), "image/png");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("image engine unavailable");
	});
});
