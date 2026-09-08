import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BedrockOptions, stream } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-sonnet-4-5",
	name: "Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const env = {
	AWS_PROFILE: "",
	AWS_REGION: "",
	AWS_DEFAULT_REGION: "",
	HTTPS_PROXY: "",
	HTTP_PROXY: "",
	ALL_PROXY: "",
	NO_PROXY: "",
};
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

it("terminalizes invalid proxy setup before any SDK call", async () => {
	const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockRejectedValue(new Error("must not send"));
	const result = await stream(
		model,
		{ messages: [] },
		{ env: { ...env, HTTPS_PROXY: "socks5://proxy.test:1080" } },
	).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("proxy");
	expect(send).not.toHaveBeenCalled();
}, 1000);

describe("Bedrock region precedence", () => {
	it.each(["ambient", "scoped", "option"])("delegates profile region resolution for %s profile", async (kind) => {
		let captured: BedrockRuntimeClient | undefined;
		vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(function (this: BedrockRuntimeClient) {
			captured = this;
			return Promise.reject(new Error("captured"));
		});
		vi.stubEnv("AWS_PROFILE", kind === "ambient" ? "europe" : "");
		vi.stubEnv("AWS_REGION", undefined);
		vi.stubEnv("AWS_DEFAULT_REGION", undefined);
		const directory = mkdtempSync(join(tmpdir(), "bedrock-profile-"));
		directories.push(directory);
		writeFileSync(join(directory, "config"), "[profile europe]\nregion = eu-west-1\n");
		writeFileSync(join(directory, "credentials"), "");
		vi.stubEnv("AWS_CONFIG_FILE", join(directory, "config"));
		vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(directory, "credentials"));
		const options: BedrockOptions = { env: { ...env } };
		if (kind === "ambient") delete options.env!.AWS_PROFILE;
		if (kind === "scoped") options.env!.AWS_PROFILE = "europe";
		if (kind === "option") options.profile = "europe";
		await stream(model, { messages: [] }, options).result();
		expect(captured?.config.profile).toBe("europe");
		expect(captured?.config.endpoint).toBeUndefined();
		// The real SDK's region provider must be left unresolved, not hard-coded to the catalog region.
		expect(await captured?.config.region()).toBe("eu-west-1");
	});
	it.each([
		{ id: model.id, region: "eu-west-1", endpoint: model.baseUrl },
		{ id: "arn:aws:bedrock:eu-west-2:123:inference-profile/example", region: "ap-south-1", endpoint: model.baseUrl },
		{ id: "arn:aws:bedrock:eu-west-2:123:inference-profile/example", region: undefined, endpoint: model.baseUrl },
		{ id: model.id, region: "eu-central-1", endpoint: "https://gateway.test" },
	])("honors explicit and ARN regions with endpoint $endpoint", async ({ id, region, endpoint }) => {
		let captured: BedrockRuntimeClient | undefined;
		vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(function (this: BedrockRuntimeClient) {
			captured = this;
			return Promise.reject(new Error("captured"));
		});
		await stream({ ...model, id, baseUrl: endpoint }, { messages: [] }, { region, env }).result();
		expect(await captured?.config.region()).toBe(id.startsWith("arn:") ? "eu-west-2" : region);
		if (endpoint === model.baseUrl) expect(captured?.config.endpoint).toBeUndefined();
		else expect(await captured?.config.endpoint?.()).toMatchObject({ hostname: "gateway.test" });
	});
});

it("destroys a raw Smithy body when onResponse rejects", async () => {
	const body = new Readable({ read() {} });
	vi.spyOn(NodeHttp2Handler.prototype, "handle").mockResolvedValue({
		response: { statusCode: 200, headers: {}, body },
	});
	// Only the transport is stubbed. The real SDK builds and resolves its middleware stack.
	const result = await stream(
		model,
		{ messages: [] },
		{
			env: { ...env, AWS_BEDROCK_SKIP_AUTH: "1" },
			onResponse: async () => {
				throw new Error("callback rejected");
			},
		},
	).result();
	expect(result.errorMessage).toContain("callback rejected");
	expect(body.destroyed).toBe(true);
});
