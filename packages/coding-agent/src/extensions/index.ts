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
 * loads these built-ins. Literal imports would evaluate extension modules while
 * the host entry is still initializing (e.g. `class FffEditor extends
 * CustomEditor` with `CustomEditor` in TDZ), depending on import order. A
 * specifier-based dynamic import defers evaluation until the factory runs,
 * when the host is fully loaded. Async factories are awaited by the extension
 * loader. The non-literal specifier also keeps these sources out of the
 * `tsc` emit graph (they ship as workspace sources loaded from the installed
 * `node_modules` tree, where their asset files live too).
 */
function lazyBuiltIn(specifier: string): ExtensionFactory {
	return async (pi: ExtensionAPI): Promise<void> => {
		const extension = (await import(specifier)) as { default: ExtensionFactory };
		await extension.default(pi);
	};
}

export const builtInExtensions: InlineExtension[] = [
	{ name: "fff", factory: lazyBuiltIn("@earendil-works/pi-ext-fff") },
	{ name: "subagents", factory: lazyBuiltIn("@earendil-works/pi-ext-subagents") },
	{ name: "web-access", factory: lazyBuiltIn("@earendil-works/pi-ext-web-access") },
	{ name: "import-repro", factory: importReproExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "mlx", factory: mlxExtension, hidden: true },
	{ name: "prompt-url-widget", factory: promptUrlWidgetExtension, hidden: true },
	{ name: "redraws", factory: redrawsExtension, hidden: true },
	{ name: "tps", factory: tpsExtension, hidden: true },
];
