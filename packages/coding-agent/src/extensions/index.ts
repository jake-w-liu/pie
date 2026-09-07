import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import importReproExtension from "./import-repro/index.ts";
import llamaExtension from "./llama/index.ts";
import mlxExtension from "./mlx/index.ts";
import promptUrlWidgetExtension from "./prompt-url-widget/index.ts";
import redrawsExtension from "./redraws/index.ts";
import tpsExtension from "./tps/index.ts";

/**
 * The fff/subagents/web-access packages import runtime values from
 * `@earendil-works/pi-coding-agent`, whose entry re-exports `./main.ts`, which
 * loads these built-ins. Literal dynamic imports defer evaluation until the
 * factory runs, when the host is fully loaded, avoiding TDZ failures such as
 * `class FffEditor extends CustomEditor` evaluating before `CustomEditor`
 * initializes (the order would otherwise depend on import order). Async
 * factories are awaited by the extension loader. The bundler follows these
 * imports and emits the packages as transpiled chunks, so shipped installs
 * never load TypeScript sources from `node_modules` at runtime (plain Node
 * refuses to strip types there). For `tsc` emit builds the specs resolve to
 * the ambient declarations in `./vendored/` (see that file); dev typechecking
 * keeps resolving the real sources.
 */
function lazyBuiltIn(loader: () => Promise<{ default: ExtensionFactory }>): ExtensionFactory {
	return async (pi: ExtensionAPI): Promise<void> => {
		const extension = await loader();
		await extension.default(pi);
	};
}

export const builtInExtensions: InlineExtension[] = [
	{ name: "fff", factory: lazyBuiltIn(() => import("@earendil-works/pi-ext-fff")) },
	{ name: "subagents", factory: lazyBuiltIn(() => import("@earendil-works/pi-ext-subagents")) },
	{ name: "web-access", factory: lazyBuiltIn(() => import("@earendil-works/pi-ext-web-access")) },
	{ name: "import-repro", factory: importReproExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "mlx", factory: mlxExtension, hidden: true },
	{ name: "prompt-url-widget", factory: promptUrlWidgetExtension, hidden: true },
	{ name: "redraws", factory: redrawsExtension, hidden: true },
	{ name: "tps", factory: tpsExtension, hidden: true },
];
