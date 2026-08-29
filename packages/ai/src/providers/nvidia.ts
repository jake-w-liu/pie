import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NVIDIA_MODELS } from "./nvidia.models.ts";
import { fetchNvidiaModels } from "./openai-completions-models.ts";

export function nvidiaProvider(): Provider<"openai-completions"> {
	const baselineIds = new Set<string>(Object.keys(NVIDIA_MODELS));
	return createProvider({
		id: "nvidia",
		name: "NVIDIA",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		auth: { apiKey: envApiKeyAuth("NVIDIA API key", ["NVIDIA_API_KEY"]) },
		models: Object.values(NVIDIA_MODELS),
		fetchModels: (context) => fetchNvidiaModels(context, baselineIds),
		api: openAICompletionsApi(),
	});
}
