import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-summary-error-test-"));
const { generateSummaryDraft } = await import("../../summary-review.ts");
const { rewriteSearchQuery } = await import("../../query-rewrite.ts");
const haiku = { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" };
const gemini = { provider: "google", id: "gemini-3.6-flash", api: "google-generative-ai" };
const calls: string[] = [];
const registry = {
	getAvailable: () => [haiku, gemini],
	find: (provider: string, id: string) => [haiku, gemini].find(model => model.provider === provider && model.id === id),
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
	complete: async (model: { provider: string }) => {
		calls.push(model.provider);
		return model.provider === "anthropic"
			? { stopReason: "error", content: [{ type: "text", text: "partial" }] }
			: { stopReason: "stop", content: [{ type: "text", text: "complete summary" }] };
	},
};
const ctx = { model: haiku, modelRegistry: registry, cwd: process.cwd(), isProjectTrusted: () => false } as never;
const results = [{ query: "q", answer: "a", results: [], error: null, provider: "exa" }] as never;
const draft = await generateSummaryDraft(results, ctx);
const summaryCalls = [...calls];
calls.length = 0;
const rewrite = await rewriteSearchQuery("original", ctx, new AbortController().signal);
console.log(JSON.stringify({ summary: draft.summary, summaryCalls, rewrite, rewriteCalls: calls }));
