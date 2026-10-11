import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-gemini-redirect-test-"));
process.env.GEMINI_API_KEY = "test-key";
const { search } = await import("../../gemini-search.ts");
const chunks = Array.from({ length: 6 }, (_, index) => ({ web: {
	uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect?id=${index}`,
	title: `source-${index}`,
} }));
let active = 0;
let maxActive = 0;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	if (init?.method !== "HEAD") return Response.json({ candidates: [{ content: { parts: [{ text: "answer" }] }, groundingMetadata: { groundingChunks: chunks } }] });
	active++;
	maxActive = Math.max(maxActive, active);
	await new Promise(resolve => setTimeout(resolve, 20));
	active--;
	const id = new URL(String(input)).searchParams.get("id");
	return new Response(null, { status: 302, headers: { location: `https://source-${id}.example/` } });
}) as typeof fetch;
const parallel = await search("q", { provider: "gemini", numResults: 6 });

const controller = new AbortController();
let abortHeads = 0;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
	if (init?.method !== "HEAD") return Response.json({ candidates: [{ content: { parts: [{ text: "answer" }] }, groundingMetadata: { groundingChunks: chunks } }] });
	abortHeads++;
	if (abortHeads === 1) queueMicrotask(() => controller.abort(new DOMException("user cancel", "AbortError")));
	await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
	throw new Error("unreachable");
}) as typeof fetch;
let abortName = "resolved";
try {
	await search("q", { provider: "gemini", signal: controller.signal });
} catch (err) {
	abortName = err instanceof Error ? err.name : String(err);
}
console.log(JSON.stringify({ maxActive, urls: parallel.results.map(result => result.url), abortName }));
