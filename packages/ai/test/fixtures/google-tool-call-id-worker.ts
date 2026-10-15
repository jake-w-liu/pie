// Streams one Gemini turn in a fresh module instance and reports the generated tool call id.
import { parentPort, workerData } from "node:worker_threads";
import { stream } from "../../src/api/google-generative-ai.ts";
import type { Model } from "../../src/types.ts";

const { baseUrl } = workerData as { baseUrl: string };
const model: Model<"google-generative-ai"> = {
	id: "gemini-2.5-flash",
	name: "Gemini",
	api: "google-generative-ai",
	provider: "google",
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};
const result = await stream(
	model,
	{ messages: [{ role: "user", content: "read", timestamp: 0 }] },
	{ apiKey: "test" },
).result();
const toolCall = result.content.find((block) => block.type === "toolCall");
parentPort?.postMessage(toolCall?.id ?? `no tool call: ${result.errorMessage}`);
