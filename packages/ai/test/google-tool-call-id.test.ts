import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Context, Model } from "../src/types.ts";

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

it("keeps generated ids of parallel calls distinct when a replay truncates them", async () => {
	// Two parallel calls of a long-named MCP tool in one chunk, neither with an id. Ids built as
	// `${name}_${uuidv7()}` differed only past character 64, and OpenAI Chat Completions keeps 40.
	const toolName = "mcp__github__list_pull_request_review_comments";
	const parallelBody = `data: ${JSON.stringify({
		candidates: [
			{
				content: {
					role: "model",
					parts: [
						{ functionCall: { name: toolName, args: { n: 1 } } },
						{ functionCall: { name: toolName, args: { n: 2 } } },
					],
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	})}\n\n`;
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(parallelBody);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const baseModel = {
			id: "gemini-2.5-flash",
			name: "Gemini",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		};
		const prompt: Context = { messages: [{ role: "user", content: "list", timestamp: 0 }] };
		const gemini: Model<"google-generative-ai"> = {
			...baseModel,
			api: "google-generative-ai",
			provider: "google",
			baseUrl: `http://127.0.0.1:${port}/v1beta`,
		};
		const vertex: Model<"google-vertex"> = {
			...baseModel,
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: `http://127.0.0.1:${port}/v1`,
		};
		const assistants = [
			await stream(gemini, prompt, { apiKey: "test" }).result(),
			await streamVertex(vertex, prompt, { apiKey: "test" }).result(),
		];
		const responsesModel: Model<"openai-responses"> = {
			...baseModel,
			id: "gpt-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		const gemini3: Model<"google-generative-ai"> = { ...gemini, id: "gemini-3-pro-preview" };

		for (const assistant of assistants) {
			const ids = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
			expect(ids).toHaveLength(2);
			// Within every provider's id charset and short enough that no replay truncates it.
			for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
			expect(new Set(ids.map((id) => id.slice(0, 40))).size).toBe(2);

			const context: Context = {
				messages: [
					...prompt.messages,
					assistant,
					...ids.map((id, index) => ({
						role: "toolResult" as const,
						toolCallId: id,
						toolName,
						content: [{ type: "text" as const, text: `result ${index}` }],
						isError: false,
						timestamp: index + 1,
					})),
				],
			};
			const responsesCallIds = convertResponsesMessages(responsesModel, context, new Set(["openai"])).flatMap(
				(item) => ("type" in item && item.type === "function_call" ? [item.call_id] : []),
			);
			expect(responsesCallIds).toEqual(ids);
			const gemini3CallIds = convertGoogleMessages(gemini3, context)
				.flatMap((content) => content.parts ?? [])
				.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : []));
			expect(gemini3CallIds).toEqual(ids);
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
