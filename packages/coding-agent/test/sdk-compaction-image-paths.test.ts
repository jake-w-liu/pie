import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { prepareCompaction } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionRuntimeFixture } from "./session-runtime-fixture.ts";

it.each([
	{ automatic: false, split: false, blocked: true },
	{ automatic: false, split: true, blocked: true },
	{ automatic: true, split: false, blocked: true },
	{ automatic: true, split: true, blocked: true },
	{ automatic: false, split: true, blocked: false },
])(
	"enforces SDK image policy through compaction (automatic=$automatic split=$split blocked=$blocked)",
	async ({ automatic, split, blocked }) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sdk-compaction-images-"));
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const f = await createSessionRuntimeFixture({ cwd: dir, sessionManager: manager });
		try {
			const { session } = f.runtime;
			const settings = { enabled: automatic, reserveTokens: 1024, keepRecentTokens: 16 };
			f.harness.settingsManager.applyOverrides({ compaction: settings, images: { blockImages: !blocked } });
			// Deliberately change policy after SDK creation; the stream must read it dynamically.
			f.harness.settingsManager.setBlockImages(blocked);
			f.harness.settingsManager.applyOverrides({ compaction: settings });
			const messages: Message[] = [];
			for (let i = 0; i < (split ? 2 : 1); i++) {
				messages.push(
					{
						role: "user",
						timestamp: i + 1,
						content: [
							{ type: "text", text: `image request ${i}` },
							{ type: "image", data: `original-user-image-${i}`, mimeType: "image/png" },
						],
					},
					fauxAssistantMessage(fauxToolCall("read", { path: "image.png" }, { id: `image-call-${i}` })),
					{
						role: "toolResult",
						timestamp: i + 1,
						toolCallId: `image-call-${i}`,
						toolName: "read",
						isError: false,
						content: [{ type: "image", data: `original-tool-image-${i}`, mimeType: "image/png" }],
					},
					fauxAssistantMessage("answer ".repeat(40)),
				);
			}
			if (!split) messages.push({ role: "user", content: "retained user request ".repeat(20), timestamp: 5 });
			const lastAssistant = messages.findLast((message) => message.role === "assistant");
			if (!lastAssistant) throw new Error("missing seed assistant");
			if (automatic) lastAssistant.usage = { ...lastAssistant.usage, input: 120000, totalTokens: 120000 };
			for (const message of messages) manager.appendMessage(message);
			session.agent.state.messages = manager.buildSessionContext().messages;
			const original = structuredClone(manager.getEntries());
			const preparation = prepareCompaction(manager.getBranch(), settings, session.model!.contextWindow);
			expect(preparation?.isSplitTurn).toBe(split);
			const captured: Context[] = [];
			const summaries = split ? 2 : 1;
			f.harness.setResponses(
				Array.from({ length: summaries + (automatic ? 1 : 0) }, (_, index) => (context: Context) => {
					captured.push(structuredClone(context));
					return fauxAssistantMessage(index < summaries ? `summary ${index}` : "continued answer");
				}),
			);
			const reasons: string[] = [];
			session.subscribe((event) => {
				if (event.type === "compaction_end" && event.result) reasons.push(event.reason);
			});
			if (automatic) await session.prompt("continue after automatic compaction");
			else await session.compact();
			expect(reasons).toEqual([automatic ? "threshold" : "manual"]);
			expect(captured).toHaveLength(summaries + (automatic ? 1 : 0));
			for (const context of captured.slice(0, summaries)) {
				const payload = JSON.stringify(context.messages);
				if (blocked) {
					expect(payload).not.toContain('"type":"image"');
					expect(payload).not.toContain("original-user-image");
					expect(payload).not.toContain("original-tool-image");
					expect(payload).toContain("Image reading is disabled."); // Raw replay, not text-only fallback.
				} else {
					expect(payload).toContain("original-user-image");
					expect(payload).toContain("original-tool-image");
				}
			}
			expect(manager.getEntries().slice(0, original.length)).toEqual(original);
			const bytes = readFileSync(manager.getSessionFile()!, "utf8");
			expect(bytes).toContain("original-user-image-0");
			expect(bytes).toContain("original-tool-image-0");
		} finally {
			await f.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
