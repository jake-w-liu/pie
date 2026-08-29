import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { HEADROOM_RETRIEVE_TOOL_NAME, type HeadroomController, headroomController } from "../headroom.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const headroomRetrieveSchema = Type.Object({
	hash: Type.String({
		description: 'The 64-character SHA-256 hash from a <headroom_compressed hash="..."> marker.',
	}),
	query: Type.Optional(
		Type.String({
			description:
				"Optional case-sensitive substring matched against original lines. Prefer this for middle content instead of reloading the full result.",
		}),
	),
	max_chars: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1_000_000,
			description: "Maximum UTF-8 bytes of original body to return (default: 12000).",
		}),
	),
	max_matches: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10_000,
			description: "Maximum matching lines when query is set (default: 50).",
		}),
	),
	context_lines: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 1_000, description: "Extra lines around each query match (default: 0)." }),
	),
});

export type HeadroomRetrieveToolInput = Static<typeof headroomRetrieveSchema>;

export function createHeadroomRetrieveToolDefinition(
	controller: HeadroomController = headroomController,
): ToolDefinition<typeof headroomRetrieveSchema, undefined> {
	return {
		name: HEADROOM_RETRIEVE_TOOL_NAME,
		label: "Headroom Retrieve",
		description:
			"Retrieve exact original content replaced by a Headroom request-time preview. Prefer query to recover specific middle lines without reloading a large body. Retrieval still works after /headroom off.",
		promptSnippet: "Retrieve exact originals stored by Headroom request compression",
		promptGuidelines: [
			"When a <headroom_compressed> preview omits content needed for the task, call headroom_retrieve with its hash. Prefer query over a full retrieval.",
		],
		parameters: headroomRetrieveSchema,
		async execute(_toolCallId, input, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const result = controller.retrieveFormatted(input.hash, {
				query: input.query,
				maxChars: input.max_chars,
				maxMatches: input.max_matches,
				contextLines: input.context_lines,
			});
			if (result.ok) {
				return { content: [{ type: "text", text: result.content }], details: undefined };
			}
			if (result.reason === "invalid_hash") {
				return {
					content: [
						{
							type: "text",
							text: `Invalid Headroom hash '${input.hash.trim()}'. Expected 64 hexadecimal characters from a <headroom_compressed> marker.`,
						},
					],
					details: undefined,
				};
			}
			const stateHint = controller.isEnabled()
				? "The original may have been evicted from the bounded store or was never compressed."
				: "Headroom is off, but stored entries remain retrievable. The original may have been evicted or was never compressed.";
			return {
				content: [
					{
						type: "text",
						text: `No Headroom content found for hash '${input.hash.trim()}'. ${stateHint}`,
					},
				],
				details: undefined,
			};
		},
	};
}

export function createHeadroomRetrieveTool(
	controller: HeadroomController = headroomController,
): AgentTool<typeof headroomRetrieveSchema> {
	return wrapToolDefinition(createHeadroomRetrieveToolDefinition(controller));
}
