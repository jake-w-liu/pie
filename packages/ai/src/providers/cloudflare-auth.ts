import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { ProviderEnv } from "../types.ts";

const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

type CloudflareAuthKind = "workers-ai" | "ai-gateway";

async function resolveValue(
	name: string,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	// Per-field merge: prefer the credential value, fall back to ambient env.
	// A credential carrying only the API key must still pick up the account /
	// gateway id from the environment.
	const fromCredential = credential
		? name === CLOUDFLARE_API_KEY
			? credential.key
			: credential.env?.[name]
		: undefined;
	if (fromCredential !== undefined) return fromCredential;
	signal.throwIfAborted();
	const value = await ctx.env(name);
	signal.throwIfAborted();
	return value;
}

async function resolveCloudflareEnv(
	kind: CloudflareAuthKind,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<{ apiKey: string; env: ProviderEnv; source: string } | undefined> {
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential, signal);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential, signal);
	const gatewayId =
		kind === "ai-gateway" ? await resolveValue(CLOUDFLARE_GATEWAY_ID, ctx, credential, signal) : undefined;

	if (!apiKey || !accountId || (kind === "ai-gateway" && !gatewayId)) return undefined;

	return {
		apiKey,
		env: {
			CLOUDFLARE_ACCOUNT_ID: accountId,
			...(gatewayId ? { CLOUDFLARE_GATEWAY_ID: gatewayId } : {}),
		},
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			interaction.signal.throwIfAborted();
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			interaction.signal.throwIfAborted();
			if (!key.trim()) {
				throw new Error("No Cloudflare API key provided");
			}
			if (!accountId.trim()) {
				throw new Error("No Cloudflare account ID provided");
			}
			return { type: "api_key", key: key.trim(), env: { CLOUDFLARE_ACCOUNT_ID: accountId.trim() } };
		},
		resolve: async ({ ctx, credential, signal }) => {
			const resolved = await resolveCloudflareEnv("workers-ai", ctx, credential, signal);
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey },
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}

export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			interaction.signal.throwIfAborted();
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			interaction.signal.throwIfAborted();
			const gatewayId = await interaction.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			interaction.signal.throwIfAborted();
			if (!key.trim()) {
				throw new Error("No Cloudflare API key provided");
			}
			if (!accountId.trim()) {
				throw new Error("No Cloudflare account ID provided");
			}
			if (!gatewayId.trim()) {
				throw new Error("No Cloudflare AI Gateway ID provided");
			}
			return {
				type: "api_key",
				key: key.trim(),
				env: { CLOUDFLARE_ACCOUNT_ID: accountId.trim(), CLOUDFLARE_GATEWAY_ID: gatewayId.trim() },
			};
		},
		resolve: async ({ ctx, credential, signal }) => {
			const resolved = await resolveCloudflareEnv("ai-gateway", ctx, credential, signal);
			if (!resolved) return undefined;
			return {
				auth: {
					headers: {
						"cf-aig-authorization": `Bearer ${resolved.apiKey}`,
						Authorization: null,
						"x-api-key": null,
					},
				},
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}
