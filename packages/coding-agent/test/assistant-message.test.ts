import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("streaming incremental updates", () => {
	test("growing thinking runs render identically with or without container rebuilds", () => {
		initTheme("dark");
		const thinking = (n: number) => `thinking block ${n} with enough words to exercise wrapping`;
		const contentFor = (count: number) =>
			Array.from({ length: count }, (_, i) => ({ type: "thinking" as const, thinking: thinking(i) }));
		// Incrementally streamed: one update per added thinking block.
		const streamed = new AssistantMessageComponent(undefined, false);
		for (let count = 1; count <= 8; count++) {
			streamed.updateContent(createAssistantMessage(contentFor(count)), true);
		}
		// Rebuilt from scratch with only the final message.
		const rebuilt = new AssistantMessageComponent(undefined, false);
		rebuilt.updateContent(createAssistantMessage(contentFor(8)), true);
		expect(streamed.render(80)).toEqual(rebuilt.render(80));
	});

	test("a thinking group replaced by text rebuilds with text styling", () => {
		initTheme("dark");
		const first = new AssistantMessageComponent(undefined, false);
		first.updateContent(createAssistantMessage([{ type: "thinking", thinking: "hmm" }]), true);
		const thinkingRender = first.render(80).join("\n");
		first.updateContent(createAssistantMessage([{ type: "text", text: "hmm" }]), true);
		const swappedRender = first.render(80).join("\n");
		const fresh = new AssistantMessageComponent(undefined, false);
		fresh.updateContent(createAssistantMessage([{ type: "text", text: "hmm" }]), true);
		// Same group count but different kinds must rebuild, not restyle in place.
		expect(swappedRender).toEqual(fresh.render(80).join("\n"));
		expect(swappedRender).not.toEqual(thinkingRender);
	});
});

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reuses the trailing Markdown component across simple streaming updates", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage([{ type: "text", text: "partial" }]), true);
		const contentContainer = Reflect.get(component, "contentContainer") as { children: unknown[] };
		const firstMarkdown = contentContainer.children[1];

		component.updateContent(createAssistantMessage([{ type: "text", text: "partial response" }]), true);

		expect(contentContainer.children[1]).toBe(firstMarkdown);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial response");
	});

	test("reuses completed thinking and text blocks while the trailing block grows", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "stable reasoning" },
				{ type: "text", text: "partial" },
			]),
			true,
		);
		const contentContainer = Reflect.get(component, "contentContainer") as { children: unknown[] };
		const thinkingComponent = contentContainer.children[1];
		const textComponent = contentContainer.children[3];

		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "stable reasoning" },
				{ type: "text", text: "partial response" },
			]),
			true,
		);

		expect(contentContainer.children[1]).toBe(thinkingComponent);
		expect(contentContainer.children[3]).toBe(textComponent);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial response");
	});

	test("streams thinking content live and reuses the block across updates", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();

		// While thinking streams, the reasoning is rendered live (not collapsed to a
		// static label) so the user sees it as it arrives. The same Markdown block is
		// reused across deltas (setText), avoiding a full tree rebuild each chunk.
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "private" }]), true);
		const contentContainer = Reflect.get(component, "contentContainer") as { children: unknown[] };
		const thinkingComponent = contentContainer.children[1];
		const streamingFirst = stripAnsi(component.render(80).join("\n"));
		expect(streamingFirst).toContain("private");
		expect(streamingFirst).not.toContain("Thinking...");

		// Growing the thinking text reuses the same block (incremental setText).
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning continues" }]),
			true,
		);
		expect(contentContainer.children[1]).toBe(thinkingComponent);
		const streamingGrowth = stripAnsi(component.render(80).join("\n"));
		expect(streamingGrowth).toContain("private reasoning continues");

		// Once the message completes, the full reasoning is still shown.
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning continues" }]),
			false,
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("private reasoning continues");
	});

	test("still collapses thinking to a label when hideThinkingBlock is set", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, true);

		// hideThinkingBlock keeps reasoning private: only the label is shown during
		// streaming and after completion, never the actual content.
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]), true);
		const streaming = stripAnsi(component.render(80).join("\n"));
		expect(streaming).not.toContain("private reasoning");
		expect(streaming).toContain("Thinking...");

		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]), false);
		const completed = stripAnsi(component.render(80).join("\n"));
		expect(completed).not.toContain("private reasoning");
		expect(completed).toContain("Thinking...");
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
