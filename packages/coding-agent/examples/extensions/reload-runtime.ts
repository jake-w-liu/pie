/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext and an LLM-callable
 * tool that schedules the reload command once the agent run settles.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Tools get ExtensionContext, so they cannot call ctx.reload() directly.
	// Instead, dispatch the command above via sendUserMessage with expandPromptTemplates so it
	// runs as a command rather than being sent to the model as literal text. Dispatch is
	// immediate and reload refuses to run while the agent streams, so defer it to agent_settled.
	let reloadQueued = false;
	pi.on("agent_settled", () => {
		if (!reloadQueued) {
			return;
		}
		reloadQueued = false;
		// Run after the settled emit unwinds; reload tears down the extension
		// runtime that is still iterating handlers.
		setTimeout(() => {
			pi.sendUserMessage("/reload-runtime", { expandPromptTemplates: true });
		}, 0);
	});

	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (ctx.isIdle()) {
				pi.sendUserMessage("/reload-runtime", { expandPromptTemplates: true });
			} else {
				reloadQueued = true;
			}
			return {
				content: [{ type: "text", text: "Scheduled /reload-runtime to run when the agent finishes." }],
				details: {},
			};
		},
	});
}
