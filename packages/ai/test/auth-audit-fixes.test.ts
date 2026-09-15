import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

// Provider model catalogs load generated `./data/*.json` (build artifact,
// absent in a fresh checkout); stub the catalog so provider-auth wiring is
// importable without running codegen.
vi.mock("../src/providers/anthropic.models.ts", () => ({ ANTHROPIC_MODELS: {} }));

import { envApiKeyAuth, lazyOAuth } from "../src/auth/helpers.ts";
import type { OAuthAuth, ProviderAuthInteraction } from "../src/auth/types.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { flattenModelCatalog } from "../src/model-catalog.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { cloudflareAIGatewayAuth, cloudflareWorkersAIAuth } from "../src/providers/cloudflare-auth.ts";
import { cleanupSessionResources, registerSessionResourceCleanup } from "../src/session-resources.ts";

function interaction(answers: string[], signal?: AbortSignal): ProviderAuthInteraction {
	const controller = new AbortController();
	let calls = 0;
	return {
		signal: signal ?? controller.signal,
		prompt: async () => {
			const answer = answers[Math.min(calls, answers.length - 1)];
			calls += 1;
			return answer;
		},
		notify: () => {},
	};
}

describe("audit fixes", () => {
	it("A1: flattenModelCatalog throws on cross-group duplicate model ids", () => {
		expect(() =>
			flattenModelCatalog("openai", {
				"api-a": { m: { kind: "a" } },
				"api-b": { m: { kind: "b" } },
			}),
		).toThrowError(/Duplicate model id "m"/);
	});

	it("A1: flattenModelCatalog still merges distinct ids", () => {
		const flat = flattenModelCatalog("openai", {
			"api-a": { m1: { kind: "a" } },
			"api-b": { m2: { kind: "b" } },
		});
		expect(Object.keys(flat).sort()).toEqual(["m1", "m2"]);
	});

	it("B2: lazyOAuth does not cache a rejected load", async () => {
		let loads = 0;
		const stub: OAuthAuth = {
			name: "stub",
			login: async () => ({ type: "oauth", refresh: "r", access: "a", expires: Date.now() + 1000 }),
			refresh: async (credential) => credential,
			toAuth: async () => ({ apiKey: "a" }),
		};
		const auth = lazyOAuth({
			name: "stub",
			load: async () => {
				loads += 1;
				if (loads === 1) throw new Error("transient import failure");
				return stub;
			},
		});
		await expect(auth.login(interaction(["x"]))).rejects.toThrowError("transient import failure");
		const credential = await auth.login(interaction(["x"]));
		expect(credential.access).toBe("a");
		expect(loads).toBe(2);
	});

	it("B3: envApiKeyAuth login stores the trimmed key", async () => {
		const auth = envApiKeyAuth("Test API key", ["TEST_AUDIT_KEY_X"]);
		const credential = await auth.login!(interaction(["  sk-x  "]));
		expect(credential.key).toBe("sk-x");
		await expect(auth.login!(interaction(["   "]))).rejects.toThrowError("No Test API key provided");
	});

	it("B4: anthropic login rejects empty keys and trims", async () => {
		const login = anthropicProvider().auth.apiKey!.login!;
		await expect(login(interaction([""]))).rejects.toThrowError("No Anthropic API key provided");
		await expect(login(interaction(["   "]))).rejects.toThrowError("No Anthropic API key provided");
		const credential = await login(interaction(["  sk-ant  "]));
		expect(credential.key).toBe("sk-ant");
	});

	it("B5: cloudflare logins validate ids and observe abort between prompts", async () => {
		const workers = cloudflareWorkersAIAuth();
		await expect(workers.login!(interaction(["   ", "acct"]))).rejects.toThrowError("No Cloudflare API key provided");
		await expect(workers.login!(interaction(["key", "   "]))).rejects.toThrowError(
			"No Cloudflare account ID provided",
		);
		const stored = await workers.login!(interaction(["  key  ", "  acct  "]));
		expect(stored.key).toBe("key");
		expect(stored.env?.CLOUDFLARE_ACCOUNT_ID).toBe("acct");

		const gateway = cloudflareAIGatewayAuth();
		await expect(gateway.login!(interaction(["k", "a", "   "]))).rejects.toThrowError(
			"No Cloudflare AI Gateway ID provided",
		);

		// Abort fires during the first prompt: the second prompt must never run.
		const controller = new AbortController();
		let prompts = 0;
		const aborting = {
			signal: controller.signal,
			notify: () => {},
			prompt: async () => {
				prompts += 1;
				controller.abort(new Error("cancelled"));
				return "key";
			},
		} satisfies ProviderAuthInteraction;
		await expect(workers.login!(aborting)).rejects.toThrow();
		expect(prompts).toBe(1);
	});

	it("D2: a directory at the ADC path does not count as credentials", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-adc-"));
		const file = join(dir, "adc.json");
		writeFileSync(file, JSON.stringify({ type: "authorized_user" }));
		mkdirSync(join(dir, "adc-dir"));

		const withPath = (path: string) => ({
			GOOGLE_APPLICATION_CREDENTIALS: path,
			GOOGLE_CLOUD_PROJECT: "proj",
			GOOGLE_CLOUD_LOCATION: "loc",
		});

		// node:fs bindings load asynchronously at module init; wait for readiness.
		let ready = false;
		for (let i = 0; i < 100 && !ready; i++) {
			if (getEnvApiKey("google-vertex", withPath(file)) === "<authenticated>") {
				ready = true;
			} else {
				await delay(20);
			}
		}
		expect(ready).toBe(true);
		expect(getEnvApiKey("google-vertex", withPath(join(dir, "adc-dir")))).toBeUndefined();
		expect(getEnvApiKey("google-vertex", withPath(join(dir, "missing.json")))).toBeUndefined();
	});

	it("G1: cleanups registered mid-cleanup run on the next call, not the current one", () => {
		const calls: string[] = [];
		const unregisters: Array<() => void> = [];
		try {
			let added = false;
			unregisters.push(
				registerSessionResourceCleanup(() => {
					calls.push("a");
					if (!added) {
						added = true;
						unregisters.push(registerSessionResourceCleanup(() => void calls.push("b")));
					}
				}),
			);
			cleanupSessionResources("s1");
			expect(calls).toEqual(["a"]);
			cleanupSessionResources("s1");
			expect(calls).toEqual(["a", "a", "b"]);
		} finally {
			for (const unregister of unregisters) unregister();
		}
	});
});

afterEach(() => {
	// Guard against leaking registrations into other tests in this file.
	cleanupSessionResources("audit-test-teardown");
});
