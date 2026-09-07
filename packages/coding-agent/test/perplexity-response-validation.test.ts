import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWithPerplexity } from "../../pi-web-access/perplexity.ts";

// No user configuration is read; all requests use a synthetic credential and fetch.
vi.mock("../../pi-web-access/utils.ts", () => ({ getWebSearchConfigPath: () => "" }));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("Perplexity response validation", () => {
	it.each([null, [], "unexpected", 42])("rejects a non-object JSON response: %j", async (body) => {
		vi.stubEnv("PERPLEXITY_API_KEY", "test-credential");
		const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		await expect(searchWithPerplexity("test query")).rejects.toThrow("expected a JSON object");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retains valid answers and citations", async () => {
		vi.stubEnv("PERPLEXITY_API_KEY", "test-credential");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							choices: [{ message: { content: "verified fixture answer" } }],
							citations: ["https://example.com/source"],
						}),
						{ status: 200 },
					),
			),
		);
		await expect(searchWithPerplexity("test query")).resolves.toEqual({
			answer: "verified fixture answer",
			results: [{ title: "Source 1", url: "https://example.com/source", snippet: "" }],
		});
	});
});
