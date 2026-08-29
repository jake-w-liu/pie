import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENV_HEADROOM,
	ENV_HEADROOM_MIN_CHARS,
	HEADROOM_RETRIEVE_TOOL_NAME,
	HeadroomController,
	headroomController,
} from "../src/core/headroom.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function largeText(lines = 180, middle?: string): string {
	return Array.from({ length: lines }, (_, index) =>
		index === Math.floor(lines / 2) && middle
			? middle
			: `line-${index.toString().padStart(4, "0")} ${"abcdefghij".repeat(5)}`,
	).join("\n");
}

function extractHash(marker: string): string {
	const hash = marker.match(/hash="([0-9a-f]{64})"/)?.[1];
	if (!hash) throw new Error("Headroom marker has no hash");
	return hash;
}

/** Trailing assistant reply that makes preceding tool results historical. */
function assistantReply(text = "ack"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 2,
	} as AgentMessage;
}

describe("HeadroomController", () => {
	it("rejects invalid programmatic limits", () => {
		expect(() => new HeadroomController({ minChars: 0 })).toThrow(
			"minChars must be a positive safe integer no greater than 1000000",
		);
		expect(() => new HeadroomController({ maxSegments: 1.5 })).toThrow(
			"maxSegments must be a positive safe integer no greater than 10000",
		);
	});

	it("defaults on, honors explicit off, and keeps retrieval available after disabling", () => {
		const env: NodeJS.ProcessEnv = {};
		const controller = new HeadroomController({ env, minChars: 50, keepLines: 6 });
		expect(controller.isEnabled()).toBe(true);

		const original = largeText(160, "MIDDLE_SECRET_ZX7");
		const marker = controller.maybeCompressContent(original, "call-1");
		expect(marker).toContain("<headroom_compressed");
		const hash = extractHash(marker!);

		controller.setEnabled(false);
		expect(controller.isEnabled()).toBe(false);
		expect(controller.maybeCompressContent(largeText(170), "call-2")).toBeUndefined();
		const retrieved = controller.retrieveFormatted(hash, { query: "MIDDLE_SECRET", maxChars: 1_000 });
		expect(retrieved).toEqual(expect.objectContaining({ ok: true }));
		if (retrieved.ok) expect(retrieved.content).toContain("MIDDLE_SECRET_ZX7");
	});

	it("compresses request copies without mutating mixed text/image tool results", () => {
		const controller = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const originalText = largeText();
		const original: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-mixed",
			toolName: "read",
			content: [
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "text", text: originalText },
				{ type: "image", data: "d29ybGQ=", mimeType: "image/png" },
			],
			details: { source: "fixture" },
			isError: false,
			timestamp: 1,
		};
		const snapshot = structuredClone(original);

		const transformed = controller.transformContext([original, assistantReply()] as AgentMessage[], true);
		expect(original).toEqual(snapshot);
		expect(transformed).not.toBe(original);
		const result = transformed[0] as ToolResultMessage;
		expect(result).not.toBe(original);
		expect(result.content[0]).toEqual(original.content[0]);
		expect(result.content[2]).toEqual(original.content[2]);
		const marker = result.content[1];
		expect(marker?.type).toBe("text");
		if (marker?.type !== "text") throw new Error("Expected text marker");
		expect(Buffer.byteLength(marker.text)).toBeLessThan(Buffer.byteLength(originalText));
		expect(controller.retrieve(extractHash(marker.text))?.content).toBe(originalText);
		expect(controller.getSessionStats().tokensSaved).toBeGreaterThan(0);
	});

	it("leaves fresh tool results raw and compresses only historical ones", () => {
		const controller = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "fresh-call",
			toolName: "read",
			content: [{ type: "text", text: largeText() }],
			isError: false,
			timestamp: 1,
		};
		const toolCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "calling read" }],
			timestamp: 1,
		} as AgentMessage;

		// Fresh: produced by the current turn, no assistant reply after it yet.
		const fresh = controller.transformContext([toolCall, result] as AgentMessage[], true);
		expect(fresh[1]).toBe(result);
		expect((fresh[1] as ToolResultMessage).content[0]).toEqual({ type: "text", text: largeText() });
		expect(controller.getSessionStats().compressedSegments).toBe(0);

		// Historical: the model already received it and replied, so it compresses.
		const seen = controller.transformContext([toolCall, result, assistantReply()] as AgentMessage[], true);
		expect(seen[1]).not.toBe(result);
		expect((seen[1] as ToolResultMessage).content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("<headroom_compressed") }),
		);
	});

	it("projects compressed request size without mutating stores or statistics", () => {
		const controller = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const original: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "projection-call",
			toolName: "read",
			content: [{ type: "text", text: largeText() }],
			isError: false,
			timestamp: 1,
		};
		const beforeStats = controller.getSessionStats();
		const beforeStore = controller.getStoreStats();

		const projected = controller.projectContext([original, assistantReply()], true) as AgentMessage[];

		expect(projected[0]).not.toBe(original);
		const projectedResult = projected[0] as ToolResultMessage;
		expect(projectedResult.content[0]?.type).toBe("text");
		if (projectedResult.content[0]?.type !== "text") throw new Error("Expected projected text marker");
		expect(projectedResult.content[0].text).toContain("<headroom_compressed");
		expect(controller.getSessionStats()).toEqual(beforeStats);
		expect(controller.getStoreStats()).toEqual(beforeStore);
		expect(controller.retrieve("0".repeat(64))).toBeUndefined();
	});

	it("returns the original arrays and objects when no segment changes", () => {
		const controller = new HeadroomController({ env: {}, minChars: 2_000 });
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "small-call",
			toolName: "read",
			content: [{ type: "text", text: "small result" }],
			isError: false,
			timestamp: 1,
		};
		const messages = [message] as AgentMessage[];

		const transformed = controller.transformContext(messages, true);
		expect(transformed).toBe(messages);
		expect(transformed[0]).toBe(message);
		expect((transformed[0] as ToolResultMessage).content).toBe(message.content);
	});

	it("does not compress when retrieval is unavailable and skips coordination tools", () => {
		const controller = new HeadroomController({ env: {}, minChars: 50, keepLines: 6 });
		const readResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: largeText() }],
			isError: false,
			timestamp: 1,
		};
		const subagentResult = { ...readResult, toolCallId: "sub-1", toolName: "subagent" };
		// Both results are followed by an assistant reply, so they are historical
		// and compressible; the coordination tool name keeps subagentResult raw.
		const messages = [readResult, subagentResult, assistantReply()] as AgentMessage[];

		expect(controller.transformContext(messages, false)).toBe(messages);
		const transformed = controller.transformContext(messages, true) as AgentMessage[];
		const read = transformed[0] as ToolResultMessage;
		expect(read.content[0]?.type).toBe("text");
		expect((read.content[0] as { text: string }).text).toContain("<headroom_compressed");
		expect(transformed[1]).toBe(subagentResult);
	});

	it("enforces a successful-segment limit and bounded FIFO store", () => {
		const controller = new HeadroomController({
			env: {},
			minChars: 50,
			keepLines: 4,
			maxSegments: 2,
			maxStoreEntries: 2,
			maxStoreChars: 50_000,
		});
		const messages = [
			...Array.from({ length: 4 }, (_, index) => ({
				role: "toolResult" as const,
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text" as const, text: largeText(120 + index) }],
				isError: false,
				timestamp: index,
			})),
			assistantReply(),
		];
		const transformed = controller.transformContext(messages, true) as ToolResultMessage[];
		const compressed = transformed.filter(
			(message) => message.content[0]?.type === "text" && message.content[0].text.includes("<headroom_compressed"),
		);
		expect(compressed).toHaveLength(2);
		expect(controller.getStoreStats().entries).toBe(2);

		const firstHash = extractHash((compressed[0]!.content[0] as { type: "text"; text: string }).text);
		const third = controller.maybeCompressContent(largeText(190), "call-new");
		expect(third).toContain("<headroom_compressed");
		expect(controller.retrieve(firstHash)).toBeUndefined();
		expect(controller.getStoreStats().entries).toBe(2);
	});

	it("reuses a marker only while its exact backing original remains stored", () => {
		const controller = new HeadroomController({
			env: {},
			minChars: 50,
			keepLines: 4,
			maxStoreEntries: 1,
			maxStoreChars: 50_000,
		});
		const firstOriginal = largeText(150, "CACHE_FIRST");
		const firstMarker = controller.maybeCompressContent(firstOriginal, "stable-call")!;
		const firstHash = extractHash(firstMarker);

		expect(controller.maybeCompressContent(firstOriginal, "stable-call")).toBe(firstMarker);
		expect(controller.getStoreStats().entries).toBe(1);
		expect(controller.getSessionStats()).toEqual(
			expect.objectContaining({ attemptedSegments: 2, compressedSegments: 2, failedSegments: 0 }),
		);

		const secondMarker = controller.maybeCompressContent(largeText(151, "CACHE_SECOND"), "other-call")!;
		expect(controller.retrieve(firstHash)).toBeUndefined();
		expect(controller.retrieve(extractHash(secondMarker))).toBeDefined();

		const restoredMarker = controller.maybeCompressContent(firstOriginal, "stable-call")!;
		expect(restoredMarker).toBe(firstMarker);
		expect(controller.retrieve(firstHash)?.content).toBe(firstOriginal);
		expect(controller.retrieve(extractHash(secondMarker))).toBeUndefined();
	});

	it("creates structural JSON previews and validates retrieval hashes", () => {
		const controller = new HeadroomController({ env: {}, minChars: 50 });
		const original = JSON.stringify(
			Array.from({ length: 40 }, (_, index) => ({ id: index, payload: "x".repeat(80) })),
		);
		const marker = controller.maybeCompressContent(original, "json-call");
		expect(marker).toContain("JSON array with 40 item(s)");
		expect(marker).toContain("__headroom_omitted_items");

		const prototypeKeyJson = `{"__proto__":{"polluted":true},"payload":"${"x".repeat(2_000)}"}`;
		const prototypeMarker = controller.maybeCompressContent(prototypeKeyJson, "json-prototype-call");
		expect(prototypeMarker).toContain('"__proto__"');
		expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
		expect(controller.retrieveFormatted("not-a-hash")).toEqual({ ok: false, reason: "invalid_hash" });
		expect(controller.retrieveFormatted("ab".repeat(32))).toEqual({ ok: false, reason: "not_found" });

		const hash = extractHash(marker!);
		expect(controller.retrieveFormatted(`0x${hash.toUpperCase()}`).ok).toBe(true);
	});

	it("filters matching lines with bounded context without loading unrelated lines", () => {
		const controller = new HeadroomController({ env: {}, minChars: 20, keepLines: 4 });
		const original = Array.from({ length: 120 }, (_, index) =>
			[10, 60, 100].includes(index) ? `line-${index} NEEDLE` : `line-${index} filler`,
		).join("\n");
		const marker = controller.maybeCompressContent(original, "query-call")!;
		const retrieved = controller.retrieveFormatted(extractHash(marker), {
			query: "NEEDLE",
			maxMatches: 2,
			contextLines: 1,
			maxChars: 4_000,
		});

		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.content).toContain("(showing 2 of 3 matching lines)");
		expect(retrieved.content).toContain("11:line-10 NEEDLE");
		expect(retrieved.content).toContain("61:line-60 NEEDLE");
		expect(retrieved.content).not.toContain("101:line-100 NEEDLE");
		expect(retrieved.content).toContain("... (lines 13-59 omitted) ...");
	});

	it("keeps UTF-8 retrieval boundaries valid and protects retrieved output from recompression", () => {
		const controller = new HeadroomController({ env: {}, minChars: 20, keepLines: 4 });
		const original = Array.from({ length: 200 }, (_, index) => `${index}:漢字🙂${"é".repeat(20)}`).join("\n");
		const marker = controller.maybeCompressContent(original, "utf8-call");
		const hash = extractHash(marker!);
		const retrieved = controller.retrieveFormatted(hash, { maxChars: 333 });
		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.content).not.toContain("�");
		expect(controller.maybeCompressContent(retrieved.content, "again")).toBeUndefined();

		const longLine = `NEEDLE ${"漢字🙂".repeat(40_000)}`;
		const longLineMarker = controller.maybeCompressContent(longLine, "long-line-call")!;
		const longLineHash = extractHash(longLineMarker);
		const fullEdges = controller.retrieveFormatted(longLineHash, { maxChars: 333 });
		expect(fullEdges.ok).toBe(true);
		if (!fullEdges.ok) return;
		expect(fullEdges.content).not.toContain("�");
		const filtered = controller.retrieveFormatted(longLineHash, {
			query: "NEEDLE",
			maxChars: 333,
		});
		expect(filtered.ok).toBe(true);
		if (!filtered.ok) return;
		expect(Buffer.byteLength(filtered.content)).toBeLessThan(700);
		expect(filtered.content).toContain("retrieve output truncated at 333 bytes");
		expect(filtered.content).not.toContain("�");
	});
});

describe("Headroom SDK integration", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		headroomController.reset();
		delete process.env[ENV_HEADROOM];
		delete process.env[ENV_HEADROOM_MIN_CHARS];
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("ships the retrieval tool and transforms only outbound context", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-headroom-sdk-"));
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_HEADROOM_MIN_CHARS] = "50";
		const originalText = largeText();
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "sdk-call",
			toolName: "read",
			content: [{ type: "text", text: originalText }],
			isError: false,
			timestamp: 1,
		};
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			expect(session.getActiveToolNames()).toContain(HEADROOM_RETRIEVE_TOOL_NAME);
			const transformed = await session.agent.transformContext!([message, assistantReply()] as AgentMessage[]);
			expect(message.content[0]).toEqual({ type: "text", text: originalText });
			expect((transformed[0] as ToolResultMessage).content[0]).toEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining("<headroom_compressed") }),
			);
		} finally {
			session.dispose();
		}
	});

	it("disables compression when an explicit tool allowlist excludes retrieval", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-headroom-sdk-no-tool-"));
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_HEADROOM_MIN_CHARS] = "50";
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "sdk-call",
			toolName: "read",
			content: [{ type: "text", text: largeText() }],
			isError: false,
			timestamp: 1,
		};
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
			tools: ["read"],
		});
		try {
			expect(session.getActiveToolNames()).not.toContain(HEADROOM_RETRIEVE_TOOL_NAME);
			const messages = [message] as AgentMessage[];
			const transformed = await session.agent.transformContext!(messages);
			expect(transformed).toEqual(messages);
			expect((transformed[0] as ToolResultMessage).content[0]).toEqual(message.content[0]);
		} finally {
			session.dispose();
		}
	});
});
