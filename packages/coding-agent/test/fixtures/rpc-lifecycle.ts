import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createSessionRuntimeFixture } from "../session-runtime-fixture.ts";

const dir = process.env.TEST_RPC_DIR;
if (!dir) throw new Error("TEST_RPC_DIR required");
const manager = SessionManager.create(dir, join(dir, "sessions"));
manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
manager.appendMessage(fauxAssistantMessage("seed answer"));
const fixture = await createSessionRuntimeFixture({
	cwd: dir,
	sessionManager: manager,
	extensions: [
		(pi) => {
			pi.on("session_start", async (event, ctx) => {
				appendFileSync(join(dir, "hooks.jsonl"), `${JSON.stringify({ type: "start", reason: event.reason })}\n`);
				if (process.env.TEST_STARTUP_DIALOGS === "1") {
					const values = [
						await ctx.ui.confirm("confirm", "confirm startup"),
						await ctx.ui.select("select", ["selected"]),
						await ctx.ui.input("input"),
						await ctx.ui.editor("editor"),
					];
					pi.appendEntry("dialog-values", values);
				}
				pi.setSessionName("initialized");
				pi.appendEntry("startup-side-effect", event.reason);
			});
			pi.on("resources_discover", () => {
				appendFileSync(join(dir, "hooks.jsonl"), `${JSON.stringify({ type: "discover" })}\n`);
			});
			pi.on("session_before_switch", (event) => ({ cancel: event.targetSessionFile === "cancel" }));
			pi.on("session_before_fork", (event) => ({ cancel: event.entryId === "cancel" }));
		},
	],
});
process.on("exit", () => {
	fixture.harness.cleanup();
});
await runRpcMode(fixture.runtime);
