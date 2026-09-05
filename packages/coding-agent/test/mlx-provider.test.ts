import { describe, expect, it } from "vitest";
import { createMlxProvider, normalizeMlxServerUrl } from "../src/extensions/mlx/provider.ts";

function stubCtx(env: Record<string, string | undefined> = {}) {
	return {
		env: async (name: string) => env[name],
		fileExists: async () => false,
	};
}

describe("mlx provider URL validation", () => {
	it("rejects non-http(s) server URLs loudly", () => {
		expect(() => normalizeMlxServerUrl("ftp://evil.example/x")).toThrow(/must use http or https/);
		expect(() => normalizeMlxServerUrl("not a url")).toThrow(/Invalid MLX server URL/);
		expect(normalizeMlxServerUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/v1");
	});

	it("reports unavailable (not throw) from check for a misconfigured stored URL", async () => {
		const { provider } = createMlxProvider();
		const result = await provider.auth.apiKey?.check?.({
			ctx: stubCtx(),
			credential: { type: "api_key", key: "k", env: { MLX_BASE_URL: "ftp://evil.example/x" } },
			signal: AbortSignal.timeout(5000),
		});
		// A throwing check would reject Promise.all in getAvailable and hide
		// every other provider's models; unavailable keeps listing intact.
		expect(result).toBeUndefined();
	});

	it("reports unavailable (not throw) from check for a misconfigured env URL", async () => {
		const { provider } = createMlxProvider();
		const result = await provider.auth.apiKey?.check?.({
			ctx: stubCtx({ MLX_BASE_URL: "ht!tp://[garbage" }),
			credential: undefined,
			signal: AbortSignal.timeout(5000),
		});
		expect(result).toBeUndefined();
	});
});
