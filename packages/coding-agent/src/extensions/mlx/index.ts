import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { createMlxProvider } from "./provider.ts";

/**
 * Built-in MLX provider extension. Registers an OpenAI-compatible provider that
 * talks to a local MLX server (`mlx_lm.server` / `mlx_vlm.server`). Models are
 * discovered from the server's `/v1/models` endpoint merged with usable local
 * checkouts under `~/models` (`MLX_MODELS_DIR` adds extra roots); the server URL
 * is taken from the stored credential or the `MLX_BASE_URL` environment variable.
 */
export default function mlxExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createMlxProvider().provider);
}
