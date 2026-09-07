import { contentText, type Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file lists as summary metadata tags. */
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	maxChars = Number.POSITIVE_INFINITY,
): string {
	if (!(maxChars > 0)) return "";
	const groups = [
		["read-files", readFiles],
		["modified-files", modifiedFiles],
	] as const;
	const fullLength = groups.reduce(
		(total, [tag, files]) =>
			total +
			(files.length ? `\n\n<${tag}>\n\n</${tag}>`.length + files.reduce((n, file) => n + file.length + 1, -1) : 0),
		0,
	);
	const omitted = "\n\n[Additional tracked files omitted here; full lists are in summary metadata.]";
	const truncated = fullLength > maxChars;
	let remaining = maxChars - (truncated ? omitted.length : 0);
	const sections: string[] = [];
	for (const [tag, files] of groups) {
		const open = `\n\n<${tag}>\n`;
		const close = `\n</${tag}>`;
		const kept: string[] = [];
		let size = open.length + close.length;
		for (const file of files) {
			const added = file.length + (kept.length ? 1 : 0);
			if (size + added > remaining) break;
			kept.push(file);
			size += added;
		}
		if (kept.length) {
			sections.push(open, kept.join("\n"), close);
			remaining -= size;
		}
	}
	if (truncated && maxChars >= omitted.length) sections.push(omitted);
	return sections.join("");
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** Safe JSON serialization shared by compaction and branch summarization. */
export { safeJsonStringify };

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps an 80% head and 20% tail joined by a marker so trailing details survive.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * 0.8);
	const tailChars = Math.max(0, maxChars - headChars);
	return `${text.slice(0, headChars)}\n\n[... middle truncated (${text.length} chars -> ${maxChars})]\n\n${text.slice(text.length - tailChars)}`;
}

function boundedContentText(content: string | readonly { type: string; text?: string }[], maxChars: number): string {
	if (typeof content === "string") return truncateForSummary(content, maxChars);

	let totalChars = 0;
	let remainingChars = maxChars;
	const parts: string[] = [];
	const trailingKeep = Math.floor(maxChars * 0.2);
	let tail = "";
	for (const block of content) {
		if (block.type !== "text" || block.text === undefined) continue;
		totalChars += block.text.length;
		tail = (tail + block.text.slice(-trailingKeep)).slice(-trailingKeep);
		if (remainingChars <= 0) continue;
		const part = block.text.slice(0, remainingChars);
		parts.push(part);
		remainingChars -= part.length;
	}

	const text = parts.join("");
	if (totalChars <= maxChars) return text;
	// Keep the true suffix without materializing the full tool-result body.
	const head = text.slice(0, Math.max(0, maxChars - trailingKeep));
	return `${head}\n\n[... middle truncated (${totalChars} chars -> ${maxChars})]\n\n${tail}`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = boundedContentText(msg.content, TOOL_RESULT_MAX_CHARS);
			if (content) {
				parts.push(`[Tool result]: ${msg.toolName} (call ${msg.toolCallId})\n${content}`);
			}
		}
	}

	return parts.join("\n\n");
}

/** Estimate the token footprint of one message after summary serialization and truncation. */
export function estimateSerializedSummaryTokens(message: Message): number {
	return Math.ceil(serializeConversation([message]).length / 4);
}
