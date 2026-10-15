import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";

// A Gemini function call without an id, so the adapter must generate one.
const body = `data: ${JSON.stringify({
	candidates: [
		{
			content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] },
			finishReason: "STOP",
		},
	],
	usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
})}\n\n`;

/** Each worker thread loads the adapter as a fresh module, like a new pi process. */
function toolCallIdFromFreshModule(baseUrl: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./fixtures/google-tool-call-id-worker.ts", import.meta.url), {
			workerData: { baseUrl },
		});
		worker.once("message", (id: string) => {
			resolve(id);
			void worker.terminate();
		});
		worker.once("error", reject);
		worker.once("exit", (code) => reject(new Error(`Worker exited with code ${code} before reporting an id`)));
	});
}

it("generates Gemini tool call ids that do not repeat in a new process", async () => {
	// A resumed session holds ids from an earlier process; a per-process counter
	// issued "read_1" again, and Anthropic rejects duplicate tool_use ids.
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const baseUrl = `http://127.0.0.1:${port}/v1beta`;
		const [first, second] = await Promise.all([
			toolCallIdFromFreshModule(baseUrl),
			toolCallIdFromFreshModule(baseUrl),
		]);
		expect(first).toMatch(/^read_/);
		expect(second).toMatch(/^read_/);
		expect(second).not.toBe(first);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
