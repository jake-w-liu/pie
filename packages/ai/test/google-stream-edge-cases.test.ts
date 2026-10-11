import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { convertMessages } from "../src/api/google-shared.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { Context, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const baseModel = {
	id: "gemini-2.5-flash",
	name: "Gemini",
	reasoning: true,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

async function withSse(body: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("Google streaming protocol edge cases", () => {
	it("surfaces blocked prompt feedback as a non-retryable provider error", async () => {
		const body = sse({
			promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
			usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 },
			responseId: "blocked-response",
		});

		await withSse(body, async (baseUrl) => {
			const googleModel: Model<"google-generative-ai"> = {
				...baseModel,
				api: "google-generative-ai",
				provider: "google",
				baseUrl: `${baseUrl}/v1beta`,
			};
			const vertexModel: Model<"google-vertex"> = {
				...baseModel,
				api: "google-vertex",
				provider: "google-vertex",
				baseUrl: `${baseUrl}/v1`,
			};

			const google = await streamGoogle(googleModel, context, { apiKey: "test" }).result();
			const vertex = await streamVertex(vertexModel, context, { apiKey: "test" }).result();

			for (const result of [google, vertex]) {
				expect(result.stopReason).toBe("error");
				expect(result.rawStopReason).toBe("PROHIBITED_CONTENT");
				expect(result.errorMessage).toContain("Provider stopped with: PROHIBITED_CONTENT");
				expect(result.usage).toMatchObject({ input: 5, totalTokens: 5 });
				expect(isRetryableAssistantError(result)).toBe(false);
			}
		});
	});

	it("preserves adjacent wire part boundaries and their thought signatures", async () => {
		const signature = "QUJDRA==";
		const body =
			sse({ candidates: [{ content: { role: "model", parts: [{ text: "visible " }] } }] }) +
			sse({
				candidates: [
					{
						content: {
							role: "model",
							parts: [{ text: "answer" }, { text: "", thoughtSignature: signature }],
						},
						finishReason: "STOP",
					},
				],
			});

		await withSse(body, async (baseUrl) => {
			const googleModel: Model<"google-generative-ai"> = {
				...baseModel,
				api: "google-generative-ai",
				provider: "google",
				baseUrl: `${baseUrl}/v1beta`,
			};
			const vertexModel: Model<"google-vertex"> = {
				...baseModel,
				api: "google-vertex",
				provider: "google-vertex",
				baseUrl: `${baseUrl}/v1`,
			};

			const results = [
				{ model: googleModel, result: await streamGoogle(googleModel, context, { apiKey: "test" }).result() },
				{ model: vertexModel, result: await streamVertex(vertexModel, context, { apiKey: "test" }).result() },
			];

			for (const { model, result } of results) {
				expect(result.content).toEqual([
					{ type: "text", text: "visible answer" },
					{ type: "text", text: "", textSignature: signature },
				]);
				const replay = convertMessages(model, { messages: [context.messages[0], result] });
				expect(replay.find((message) => message.role === "model")?.parts).toEqual([
					{ text: "visible answer" },
					{ text: "", thoughtSignature: signature },
				]);
			}
		});
	});
});
