import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * A hung provider must not outlive the documented video-processing deadline. `fetch`
 * only settles on abort, so without a deadline signal on the upload and poll requests a
 * peer that never answers keeps the extraction pending forever.
 */
let scratch: string;
let agentDir: string;
let videoPath: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-video-deadline-"));
	agentDir = join(scratch, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ video: { flowTimeoutMs: 1_500 } }));
	videoPath = join(scratch, "clip.mp4");
	writeFileSync(videoPath, Buffer.alloc(4096));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.GEMINI_API_KEY = "fixture-key";
});

afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.GEMINI_API_KEY;
	rmSync(scratch, { recursive: true, force: true });
});

it("aborts a hung video upload at the configured deadline", async () => {
	const originalFetch = globalThis.fetch;
	// A request that only settles when its signal aborts, like a real hung fetch.
	globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
		new Promise((_resolve, reject) => {
			const signal = init?.signal;
			const fail = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail);
		})) as typeof globalThis.fetch;
	// A real fetch holds a socket open; the stub needs the loop kept alive so
	// `AbortSignal.timeout` can actually fire.
	const keepAlive = setInterval(() => {}, 50);
	try {
		const { extractVideo, isVideoFile } = await import("../../pi-web-access/video-extract.ts");
		const info = isVideoFile(videoPath);
		expect(info).not.toBeNull();
		const started = Date.now();
		await extractVideo(info!);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(1_000);
		expect(elapsed).toBeLessThan(30_000);
	} finally {
		clearInterval(keepAlive);
		globalThis.fetch = originalFetch;
	}
}, 60_000);
