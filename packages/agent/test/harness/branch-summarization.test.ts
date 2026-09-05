import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	collectEntriesForBranchSummary,
	generateBranchSummary,
} from "../../src/harness/compaction/branch-summarization.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { Entry } from "../../src/harness/session/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

function message(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("v4 branch summarization", () => {
	it("collects the abandoned side of a branch in chronological order", async () => {
		let nextId = 0;
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }), {
			idGenerator: { next: () => `entry-${++nextId}` },
		});
		const rootId = await session.appendMessage(message("root"));
		const commonId = await session.appendMessage(message("common"));
		const abandonedIds = [
			await session.appendMessage(message("abandoned 1")),
			await session.appendMessage(message("abandoned 2")),
		];
		await session.createLane("target", commonId);
		const targetId = await session.view("target").appendMessage(message("target"));

		const result = await collectEntriesForBranchSummary(session, abandonedIds[1]!, targetId);
		expect(result.commonAncestorId).toBe(commonId);
		expect(result.entries.map((entry) => entry.id)).toEqual(abandonedIds);
		expect(result.entries.some((entry) => entry.id === rootId)).toBe(false);
	});

	it("returns no entries when there was no previous leaf", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }));
		const targetId = await session.appendMessage(message("target"));
		expect(await collectEntriesForBranchSummary(session, null, targetId)).toEqual({
			entries: [],
			commonAncestorId: null,
		});
	});

	it("includes large tool results at their bounded serialized size", async () => {
		const toolCallId = "branch-tool";
		const branchEntries: Entry[] = [
			{
				type: "message",
				id: "assistant",
				parentId: null,
				seq: 1,
				timestamp: 1,
				message: fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }, { id: toolCallId }), {
					stopReason: "toolUse",
				}),
			},
			{
				type: "message",
				id: "result",
				parentId: "assistant",
				seq: 2,
				timestamp: 2,
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: `critical result ${"x".repeat(20_000)}` }],
					isError: false,
					timestamp: 2,
				},
			},
		];
		let requestContext: Context | undefined;
		const models = createModels();
		const faux = fauxProvider({
			provider: "branch-tool-result",
			models: [{ id: "model", contextWindow: 5000, maxTokens: 2048 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			(context) => {
				requestContext = context;
				return fauxAssistantMessage("summary");
			},
		]);

		getOrThrow(
			await generateBranchSummary(branchEntries, {
				models,
				model: faux.getModel(),
				reserveTokens: 1000,
				signal: new AbortController().signal,
			}),
		);

		const prompt = JSON.stringify(requestContext?.messages);
		expect(prompt).toContain("[Tool result]: critical result");
		expect(prompt).toContain("[... middle truncated (");
	});

	it("carries file tracking forward from compaction details", async () => {
		const entriesWithCompaction: Entry[] = [
			{
				type: "compaction",
				id: "compaction",
				parentId: null,
				seq: 1,
				timestamp: 1,
				summary: "Earlier work",
				retainedTail: [],
				tokensBefore: 1000,
				details: { readFiles: ["read-before.txt"], modifiedFiles: ["changed-before.ts"] },
			},
			{
				type: "message",
				id: "user",
				parentId: "compaction",
				seq: 2,
				timestamp: 2,
				message: message("continue"),
			},
		];
		const models = createModels();
		const faux = fauxProvider({ provider: "branch-file-details", models: [{ id: "model" }] });
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("summary")]);

		const result = getOrThrow(
			await generateBranchSummary(entriesWithCompaction, {
				models,
				model: faux.getModel(),
				signal: new AbortController().signal,
			}),
		);

		expect(result.readFiles).toEqual(["read-before.txt"]);
		expect(result.modifiedFiles).toEqual(["changed-before.ts"]);
	});

	it("rejects truncated, tool-only, and empty branch summaries", async () => {
		const branchEntries: Entry[] = [
			{
				type: "message",
				id: "user",
				parentId: null,
				seq: 1,
				timestamp: 1,
				message: message("summarize"),
			},
		];
		const cases = [
			{
				response: fauxAssistantMessage("partial", { stopReason: "length" }),
				message: "Branch summary failed: generation hit the token cap and the summary is incomplete",
			},
			{
				response: fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
				message: "Branch summary attempted to call a tool",
			},
			{
				response: { ...fauxAssistantMessage(""), content: [{ type: "thinking" as const, thinking: "internal" }] },
				message: "Branch summary failed: response contained no summary text",
			},
		];

		for (let index = 0; index < cases.length; index++) {
			const testCase = cases[index]!;
			const models = createModels();
			const faux = fauxProvider({ provider: `branch-invalid-${index}`, models: [{ id: "model" }] });
			models.setProvider(faux.provider);
			faux.setResponses([testCase.response]);

			const result = await generateBranchSummary(branchEntries, {
				models,
				model: faux.getModel(),
				signal: new AbortController().signal,
			});
			expect(result).toMatchObject({
				ok: false,
				error: { code: "summarization_failed", message: testCase.message },
			});
		}
	});
});
