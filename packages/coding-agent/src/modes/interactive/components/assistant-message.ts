import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type StreamingGroup = { kind: "text" | "thinking"; text: string };
type StreamingRenderedBlock = { kind: "text" | "thinking"; component: Markdown | Text };

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private streamingSignature?: string;
	private streamingBlocks: StreamingRenderedBlock[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.streamingSignature = undefined;
		this.streamingBlocks = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.streamingSignature = undefined;
		this.streamingBlocks = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.streamingSignature = undefined;
		this.streamingBlocks = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.streamingSignature = undefined;
		this.streamingBlocks = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	private getStreamingLayout(message: AssistantMessage): {
		signature: string;
		groups: StreamingGroup[];
		hasToolCalls: boolean;
	} {
		const signature: string[] = [];
		const groups: StreamingGroup[] = [];
		let hasToolCalls = false;
		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index]!;
			if (content.type === "text") {
				const text = content.text.trim();
				signature.push(`text:${text ? 1 : 0}`);
				if (text) groups.push({ kind: "text", text });
				continue;
			}
			if (content.type === "thinking") {
				const blocks: string[] = [];
				let runLength = 0;
				for (; index < message.content.length && message.content[index]?.type === "thinking"; index++) {
					runLength++;
					const thinking = message.content[index];
					if (thinking?.type === "thinking" && thinking.thinking.trim()) blocks.push(thinking.thinking.trim());
				}
				index--;
				const text = blocks.join("\n\n");
				signature.push(`thinking:${runLength}:${text ? 1 : 0}`);
				if (text) groups.push({ kind: "thinking", text });
				continue;
			}
			hasToolCalls = true;
			signature.push(`tool:${content.id}`);
		}
		return { signature: signature.join("|"), groups, hasToolCalls };
	}

	private updateStreamingContent(message: AssistantMessage): void {
		const layout = this.getStreamingLayout(message);
		if (this.streamingSignature === layout.signature && this.streamingBlocks.length === layout.groups.length) {
			for (let index = 0; index < layout.groups.length; index++) {
				const group = layout.groups[index]!;
				const rendered = this.streamingBlocks[index]!;
				if (rendered.kind !== group.kind) break;
				if (rendered.component instanceof Markdown) rendered.component.setText(group.text);
			}
			this.hasToolCalls = layout.hasToolCalls;
			return;
		}

		this.contentContainer.clear();
		this.streamingBlocks = [];
		if (layout.groups.length > 0) this.contentContainer.addChild(new Spacer(1));
		for (let index = 0; index < layout.groups.length; index++) {
			const group = layout.groups[index]!;
			let component: Markdown | Text;
			if (group.kind === "text") {
				component = new Markdown(group.text, this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", true, this.markdownTransformers),
				});
			} else if (this.hideThinkingBlock) {
				// Thinking is meant to be hidden: keep a single compact label for the
				// whole run so the user knows the agent is thinking without revealing
				// the reasoning. The full content is never shown.
				component = new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0);
			} else {
				// Stream the actual reasoning live. Rendered as an incrementally-updated
				// Markdown block (setText on each delta, no tree rebuild), matching how
				// assistant text already streams. The transcript's follow-end scroll keeps
				// the new content in view without constant full repaints.
				component = new Markdown(
					group.text,
					this.outputPad,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					},
					{
						transform: createMarkdownTransform("assistant-thinking", true, this.markdownTransformers),
					},
				);
			}
			this.contentContainer.addChild(component);
			this.streamingBlocks.push({ kind: group.kind, component });
			if (group.kind === "thinking" && index < layout.groups.length - 1) {
				this.contentContainer.addChild(new Spacer(1));
			}
		}
		this.streamingSignature = layout.signature;
		this.hasToolCalls = layout.hasToolCalls;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		if (isStreaming) {
			this.updateStreamingContent(message);
			return;
		}

		this.streamingSignature = undefined;
		this.streamingBlocks = [];
		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const markdown = new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
				});
				this.contentContainer.addChild(markdown);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
