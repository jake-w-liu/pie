import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { type Api, createProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];
const originalTelemetry = process.env.PI_TELEMETRY;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalTelemetry === undefined) delete process.env.PI_TELEMETRY;
	else process.env.PI_TELEMETRY = originalTelemetry;
});

/** ProviderHeaders may mark a header unset with null; Headers only accepts concrete strings. */
function concreteHeaders(headers: ProviderHeaders | undefined): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
}

function model(provider: string): Model<Api> {
	return {
		provider,
		id: "model",
		name: "model",
		api: "openai-completions",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("provider header precedence", () => {
	it("lets configured headers replace inherited headers case-insensitively", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provider-headers-"));
		tempDirs.push(dir);
		const configPath = join(dir, "models.json");
		writeFileSync(configPath, JSON.stringify({ providers: { test: { headers: { authorization: "configured" } } } }));
		const config = await ModelConfig.load(configPath);
		const base = createProvider({
			id: "test",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => ({ auth: { headers: { Authorization: "inherited" } } }),
				},
			},
			models: [model("test")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		});
		const provider = composeModelProvider("test", base, config, undefined);

		const resolved = await provider.auth.apiKey?.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: { type: "api_key", key: "key" },
			signal: new AbortController().signal,
		});

		expect(resolved?.auth.headers).toEqual({ authorization: "configured" });
		expect(new Headers(concreteHeaders(resolved?.auth.headers)).get("authorization")).toBe("configured");
	});

	it("lets explicit attribution headers replace defaults case-insensitively", () => {
		process.env.PI_TELEMETRY = "1";
		const headers = mergeProviderAttributionHeaders(
			model("cloudflare-ai-gateway"),
			{} as SettingsManager,
			undefined,
			{ "user-agent": "custom-client" },
		);

		expect(headers).toEqual({ "user-agent": "custom-client" });
		expect(new Headers(concreteHeaders(headers)).get("user-agent")).toBe("custom-client");
	});
});
