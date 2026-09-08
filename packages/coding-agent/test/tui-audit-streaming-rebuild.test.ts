import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createInteractiveHarness, deferred } from "./tui-audit-helpers.ts";

const mocks = vi.hoisted(() => ({ convert: vi.fn() }));
vi.mock("../src/utils/image-convert.ts", () => ({ convertToPng: mocks.convert }));

type Harness = Awaited<ReturnType<typeof createInteractiveHarness>>;

function toggleCacheNotices(harness: Harness) {
	const show = Reflect.get(harness.mode, "showSettingsSelector") as () => void;
	show.call(harness.mode);
	const selector = harness.editorContainer.children[0];
	expect(selector).toBeInstanceOf(SettingsSelectorComponent);
	if (!(selector instanceof SettingsSelectorComponent)) throw new Error("Missing settings selector");
	const list = selector.getSettingsList();
	for (const character of "Cache miss notices") list.handleInput(character);
	const previous = harness.settingsManager.getShowCacheMissNotices();
	list.handleInput("\r");
	expect(harness.settingsManager.getShowCacheMissNotices()).toBe(!previous);
	list.handleInput("\x1b");
}

function subscribe(harness: Harness, inspect?: (event: AgentSessionEvent) => void) {
	const handle = Reflect.get(harness.mode, "handleEvent") as (event: AgentSessionEvent) => Promise<void>;
	const pending: Promise<void>[] = [];
	const errors: unknown[] = [];
	const unsubscribe = harness.session.subscribe((event) => {
		pending.push(handle.call(harness.mode, event));
		try {
			inspect?.(event);
		} catch (error) {
			errors.push(error);
		}
	});
	return async () => {
		unsubscribe();
		await Promise.all(pending);
		if (errors.length > 0) throw errors[0];
	};
}

function pendingTools(harness: Harness) {
	return Reflect.get(harness.mode, "pendingTools") as Map<string, ToolExecutionComponent>;
}
function transcript(harness: Harness) {
	return harness.chat.render(120).map(stripAnsi).join("\n");
}

describe("settings rebuilds during real faux streaming", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		mocks.convert.mockReset();
	});

	it.each(["text", "thinking", "toolCall", "error", "aborted"] as const)(
		"keeps a live %s component receiving deltas through completion",
		async (kind) => {
			const harness = await createInteractiveHarness({
				settings: { retry: { enabled: false }, hideThinkingBlock: false },
			});
			try {
				const response = fauxAssistantMessage(
					kind === "thinking"
						? [fauxThinking("reasoning completion sentinel"), fauxText("final answer sentinel")]
						: kind === "toolCall"
							? [
									fauxText("tool preface sentinel"),
									fauxToolCall(
										"missing-audit-tool",
										{ input: "argument completion sentinel" },
										{ id: "audit-call" },
									),
								]
							: "final answer completion sentinel",
					{
						stopReason: kind === "error" || kind === "aborted" ? kind : kind === "toolCall" ? "toolUse" : "stop",
						errorMessage: kind === "error" ? "expected stream error" : undefined,
					},
				);
				harness.setResponses([
					fauxAssistantMessage("history answer"),
					response,
					fauxAssistantMessage("after tool sentinel"),
				]);
				await harness.session.prompt("history prompt");
				harness.mode.renderInitialMessages();
				let toggles = 0;
				let live: AssistantMessageComponent | undefined;
				const finish = subscribe(harness, (event) => {
					if (event.type !== "message_update" || event.message.role !== "assistant" || toggles !== 0) return;
					const delta = event.assistantMessageEvent.type;
					if (
						kind === "thinking"
							? delta !== "thinking_delta"
							: kind === "toolCall"
								? delta !== "toolcall_delta"
								: delta !== "text_delta"
					)
						return;
					toggles++;
					live = Reflect.get(harness.mode, "streamingComponent") as AssistantMessageComponent;
					const before = transcript(harness);
					const tools = new Map(pendingTools(harness));
					toggleCacheNotices(harness);
					expect(harness.chat.children).toContain(live);
					expect(transcript(harness)).toBe(before);
					for (const [id, component] of tools) expect(pendingTools(harness).get(id)).toBe(component);
					toggleCacheNotices(harness);
					expect(harness.chat.children.filter((child) => child === live)).toHaveLength(1);
				});
				await harness.session.prompt("stream prompt");
				await finish();
				expect(toggles).toBe(1);
				expect(harness.chat.children).toContain(live);
				const output = transcript(harness);
				expect(output).toContain(
					kind === "thinking"
						? "reasoning completion sentinel"
						: kind === "toolCall"
							? "tool preface sentinel"
							: "final answer completion sentinel",
				);
				if (kind === "thinking") expect(output).toContain("final answer sentinel");
				if (kind === "error") expect(output).toContain("expected stream error");
				const assistantCount = harness.chat.children.filter(
					(child) => child instanceof AssistantMessageComponent,
				).length;
				toggleCacheNotices(harness);
				toggleCacheNotices(harness);
				expect(harness.chat.children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(
					assistantCount,
				);
				expect(transcript(harness).match(/history answer/g)).toHaveLength(1);
				expect(pendingTools(harness).size).toBe(0);
			} finally {
				harness.cleanup();
			}
		},
	);

	it("applies historical cache-notice visibility immediately rather than deferring rebuilds during streaming", async () => {
		const harness = await createInteractiveHarness({ settings: { showCacheMissNotices: true } });
		try {
			for (const cached of [true, false]) {
				const message = fauxAssistantMessage(cached ? "cache seed" : "cache miss history");
				message.usage = {
					input: cached ? 0 : 25_000,
					cacheWrite: cached ? 25_000 : 0,
					cacheRead: 0,
					output: 1,
					totalTokens: 25_001,
					cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
				};
				harness.sessionManager.appendMessage(message);
			}
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			harness.mode.renderInitialMessages();
			expect(transcript(harness).match(/Cache miss:/g)).toHaveLength(1);
			harness.setResponses([fauxAssistantMessage("live completion sentinel")]);
			let toggled = false;
			const finish = subscribe(harness, (event) => {
				if (toggled || event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
				toggled = true;
				const live = Reflect.get(harness.mode, "streamingComponent") as AssistantMessageComponent;
				toggleCacheNotices(harness);
				expect(transcript(harness)).not.toContain("Cache miss:");
				expect(harness.chat.children).toContain(live);
				toggleCacheNotices(harness);
				expect(transcript(harness).match(/Cache miss:/g)).toHaveLength(1);
				expect(harness.chat.children).toContain(live);
			});
			await harness.session.prompt("continue");
			await finish();
			expect(toggled).toBe(true);
			expect(transcript(harness)).toContain("live completion sentinel");
		} finally {
			harness.cleanup();
		}
	});

	it("retains a persisted pending tool's partial output and image work, then renders its final result once", async () => {
		const reached = deferred<void>();
		const complete = deferred<void>();
		const conversion = deferred<{ data: string; mimeType: string } | null>();
		mocks.convert.mockReturnValue(conversion.promise);
		const image = { type: "image" as const, data: "source-jpeg", mimeType: "image/jpeg" };
		const harness = await createInteractiveHarness({
			tools: [
				{
					name: "audit-tool",
					label: "Audit tool",
					description: "Offline streaming fixture",
					parameters: Type.Object({ input: Type.String() }),
					execute: async (_id, _args, _signal, onUpdate) => {
						onUpdate?.({ content: [fauxText("partial output sentinel"), image], details: {} });
						await complete.promise;
						return { content: [fauxText("final output sentinel"), image], details: {} };
					},
				},
			],
		});
		try {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			harness.setResponses([
				fauxAssistantMessage(
					[fauxText("tool preface"), fauxToolCall("audit-tool", { input: "args" }, { id: "audit-call" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("final assistant sentinel"),
			]);
			const finish = subscribe(harness, (event) => {
				if (event.type === "tool_execution_update") reached.resolve();
			});
			const prompt = harness.session.prompt("run tool");
			await reached.promise;
			const tool = pendingTools(harness).get("audit-call")!;
			expect(tool).toBeInstanceOf(ToolExecutionComponent);
			expect(transcript(harness)).toContain("partial output sentinel");
			expect(mocks.convert).toHaveBeenCalledTimes(1);
			toggleCacheNotices(harness);
			expect(pendingTools(harness).get("audit-call")).toBe(tool);
			expect(harness.chat.children).toContain(tool);
			expect(transcript(harness)).toContain("partial output sentinel");
			conversion.resolve({
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
				mimeType: "image/png",
			});
			await Promise.resolve();
			const converted = Reflect.get(tool, "convertedImages") as Map<number, { sourceData: string }>;
			expect(converted.get(0)?.sourceData).toBe("source-jpeg");
			complete.resolve();
			await prompt;
			await finish();
			expect(harness.chat.children).toContain(tool);
			expect(mocks.convert).toHaveBeenCalledTimes(1);
			expect(transcript(harness)).toContain("final output sentinel");
			expect(transcript(harness)).toContain("final assistant sentinel");
			expect(pendingTools(harness).size).toBe(0);
			toggleCacheNotices(harness);
			expect(harness.chat.children.filter((child) => child instanceof ToolExecutionComponent)).toHaveLength(1);
			expect(transcript(harness).match(/final output sentinel/g)).toHaveLength(1);
		} finally {
			conversion.resolve(null);
			complete.resolve();
			await harness.session.abort();
			harness.cleanup();
		}
	});
});
