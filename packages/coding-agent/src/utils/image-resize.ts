import { Worker } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave the
	// caller's bytes intact.
	return new Uint8Array(input);
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return value !== null && typeof value === "object";
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
	signal?: AbortSignal,
): Promise<ResizedImage | null> {
	signal?.throwIfAborted();
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
			const settle = (result: ResizedImage | null): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onAbort = (): void => fail(new Error("Operation aborted"));

			worker.once("message", (message: unknown) => {
				if (!isResizeImageWorkerResponse(message)) {
					fail(new Error("Invalid image resize worker response"));
					return;
				}
				if (message.error) {
					fail(new Error(message.error));
					return;
				}
				settle(message.result ?? null);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		await worker.terminate().catch(() => undefined);
	}
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop. If the worker cannot be loaded (for example in some
 * Bun compiled executable layouts), fall back to in-process resizing so image
 * reads still work.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
	signal?: AbortSignal,
): Promise<ResizedImage | null> {
	signal?.throwIfAborted();
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun compiled executables resolve worker entrypoints by string path, not via
	// new URL(..., import.meta.url). Try the string path first under Bun so the
	// release binary uses the embedded worker instead of falling back in-process.
	if (typeof process.versions.bun === "string") {
		try {
			const bunWorkerResult = await resizeImageInWorker(
				"./src/utils/image-resize-worker.ts",
				inputBytes,
				mimeType,
				options,
				signal,
			);
			if (bunWorkerResult) {
				return bunWorkerResult;
			}
		} catch (error) {
			if (signal?.aborted) throw error;
		}
	}

	try {
		const workerResult = await resizeImageInWorker(workerUrl, inputBytes, mimeType, options, signal);
		if (workerResult) {
			return workerResult;
		}
	} catch (error) {
		if (signal?.aborted) throw error;
		// Fall through to in-process resizing below.
	}
	signal?.throwIfAborted();
	// A worker that runs but returns null (e.g. its image backend failed to load
	// after a release swap) must not veto the in-process path. Genuinely
	// unfittable images simply fail here a second time and still return null.
	return resizeImageInProcess(inputBytes, mimeType, options);
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
