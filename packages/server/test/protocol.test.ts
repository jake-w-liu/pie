import type { Api, AssistantMessage, Model, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	decodeCbor,
	encodeCbor,
	encodeServerMessage,
	PROTOCOL_VERSION,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	sanitizeProtocolDetails,
	toProtocolAssistantMessage,
	toProtocolJsonValue,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "../src/protocol.ts";

const model = {
	id: "model-1",
	name: "Model One",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} satisfies Model<Api>;

type ProtocolTranscriptItem =
	| ReturnType<typeof toProtocolAssistantMessage>
	| ReturnType<typeof toProtocolUserMessage>
	| ReturnType<typeof toProtocolToolResultMessage>;

function assertValidServerPayload(item: ProtocolTranscriptItem): ProtocolTranscriptItem {
	expect(() =>
		encodeServerMessage({
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: "connection-1",
			snapshot: {
				serverId: "server-1",
				protocolVersion: PROTOCOL_VERSION,
				revision: 0,
				sessions: [
					{
						id: "session-1",
						createdAt: 1,
						updatedAt: 1,
						sessionName: "Session one",
						cwd: "/workspace",
					},
				],
				models: [toProtocolModelMetadata(model, true)],
			},
		}),
	).not.toThrow();

	const frame = encodeServerMessage({
		type: "event",
		event: {
			type: "session_snapshot",
			snapshot: {
				id: "session-1",
				cwd: "/workspace",
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model: { provider: "test-provider", id: "model-1" },
				thinkingLevel: "off",
				attached: true,
				locked: true,
				revision: 1,
				transcript: [item],
				queuedSteer: [],
				queuedSteerCount: 0,
			},
		},
	});
	const decoder = new ServerMessageDecoder();
	const messages = [...decoder.push(frame.subarray(0, 7)), ...decoder.push(frame.subarray(7))];
	decoder.end();
	const message = messages[0];
	if (messages.length !== 1 || message.type !== "event" || message.event.type !== "session_snapshot") {
		throw new Error("Expected one complete session snapshot envelope");
	}
	expect(message.event.snapshot.transcript).toEqual([item]);
	return message.event.snapshot.transcript[0];
}

describe("pi-ai protocol bridge", () => {
	test("maps model metadata and produces protocol-valid output", () => {
		const result = toProtocolModelMetadata(model, true);

		expect(result).toMatchObject({
			provider: "test-provider",
			id: "model-1",
			api: "test-api",
			input: ["text", "image"],
			authenticated: true,
		});
		expect(result.supportedThinkingLevels).toContain("off");
	});

	test("exhaustively maps assistant content and stop reasons", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "hmm", redacted: false },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			},
			stopReason: "toolUse",
			timestamp: 123,
		} satisfies AssistantMessage;

		const result = toProtocolAssistantMessage(message, { id: "message-1" });

		expect(result).toMatchObject({
			id: "message-1",
			status: "complete",
			stopReason: "toolUse",
			model: { provider: "test-provider", id: "model-1" },
		});
		expect(result.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "hmm", redacted: false },
			{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } },
		]);
		assertValidServerPayload(result);
	});

	test("maps user and tool messages without leaking non-JSON details", () => {
		const user = {
			role: "user",
			content: "hello",
			timestamp: 1,
		} satisfies UserMessage;
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const tool = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			details: circular,
			isError: false,
			timestamp: 2,
		} satisfies ToolResultMessage;
		const call = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
		} satisfies ToolCall;

		const userResult = toProtocolUserMessage(user, { id: "user-1" });
		expect(userResult).toMatchObject({
			id: "user-1",
			content: [{ type: "text", text: "hello" }],
		});
		assertValidServerPayload(userResult);

		const toolResult = toProtocolToolResultMessage(tool, {
			id: "tool-1",
			call,
		});
		expect(toolResult).toMatchObject({
			id: "tool-1",
			toolName: "read",
			input: { path: "README.md" },
			details: { self: "[Circular]" },
			status: "complete",
		});
		assertValidServerPayload(toolResult);
	});

	test("lossily preserves invalid Date diagnostics through a complete tool-result envelope", () => {
		const valid = new Date("2024-01-02T03:04:05.000Z");
		const invalid = new Date(Number.NaN);
		const details = Object.defineProperty({ valid, nested: [invalid] }, "__proto__", {
			value: invalid,
			enumerable: true,
		});
		const call: ToolCall = { type: "toolCall", id: "date-call", name: "inspect", arguments: {} };
		const result = toProtocolToolResultMessage(
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "completed" }],
				details,
				isError: false,
				timestamp: 1,
			},
			{ id: "date-result", call },
		);
		expect(sanitizeProtocolDetails(invalid)).toBe("Invalid Date");
		expect(result.details).toEqual(
			JSON.parse('{"valid":"2024-01-02T03:04:05.000Z","nested":["Invalid Date"],"__proto__":"Invalid Date"}'),
		);
		expect(result.status).toBe("complete");
		expect(Object.hasOwn(result.details as object, "__proto__")).toBe(true);
		assertValidServerPayload(result);
		expect(Number.isNaN(invalid.getTime())).toBe(true);
		for (const date of [valid, invalid]) expect(() => toProtocolJsonValue(date)).toThrow("plain objects");
	});

	test("rejects tool results associated with a different call", () => {
		const call = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
		} satisfies ToolCall;
		const result = {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		} satisfies ToolResultMessage;

		expect(() => toProtocolToolResultMessage(result, { id: "tool-1", call })).toThrow(/tool call/i);
		expect(() =>
			toProtocolToolResultMessage({ ...result, toolCallId: "call-1", toolName: "write" }, { id: "tool-1", call }),
		).toThrow(/tool call/i);
	});

	test("derives streaming status from a pending stop reason", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: 123,
		} satisfies AssistantMessage;

		const result = toProtocolAssistantMessage(message, { id: "message-pending" });
		expect(result).toMatchObject({ status: "streaming" });
		expect(result).not.toHaveProperty("stopReason");
		assertValidServerPayload(result);
	});

	test("preserves optional non-empty assistant error messages", () => {
		const message = {
			role: "assistant",
			content: [],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: 123,
		} satisfies AssistantMessage;

		const resultWithoutMessage = toProtocolAssistantMessage(message, { id: "message-error" });
		expect(resultWithoutMessage).toMatchObject({ status: "error", stopReason: "error" });
		expect(resultWithoutMessage).not.toHaveProperty("errorMessage");
		assertValidServerPayload(resultWithoutMessage);
		expect(() => toProtocolAssistantMessage({ ...message, errorMessage: "" }, { id: "message-error" })).toThrow(
			TypeError,
		);
		const resultWithMessage = toProtocolAssistantMessage(
			{ ...message, errorMessage: "failed" },
			{ id: "message-error" },
		);
		expect(resultWithMessage).toMatchObject({ status: "error", stopReason: "error", errorMessage: "failed" });
		assertValidServerPayload(resultWithMessage);
	});

	test("rejects invalid source identifiers and timestamps", () => {
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "", name: "read", arguments: {} }],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		} satisfies AssistantMessage;

		expect(() => toProtocolAssistantMessage(message, { id: "assistant-1" })).toThrow(/tool call id/i);
		expect(() =>
			toProtocolUserMessage({ role: "user", content: "hello", timestamp: Number.NaN }, { id: "user-1" }),
		).toThrow(/timestamp/i);
	});

	test.each([
		["execution input", toProtocolJsonValue],
		["diagnostic details", sanitizeProtocolDetails],
	] as const)("preserves prototype-named JSON keys in %s", (_name, convert) => {
		const input: unknown = JSON.parse(
			'{"__proto__":{"polluted":true},"nested":[{"__proto__":null}],"constructor":"data","prototype":7}',
		);
		const result = convert(input);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
		expect(result).toEqual(input);
		expect(decodeCbor(encodeCbor(result))).toEqual(input);
		expect(toProtocolJsonValue(result)).toEqual(input);
	});

	test("roundtrips dangerous JSON keys through converted tool inputs/details and a full protocol envelope", () => {
		const input: Record<string, unknown> = JSON.parse(
			'{"__proto__":{"nested":{"__proto__":7}},"constructor":{"prototype":true},"list":[{"__proto__":null}]}',
		);
		const call: ToolCall = { type: "toolCall", id: "call-1", name: "read", arguments: input };
		const tool = toProtocolToolResultMessage(
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "done" }],
				details: input,
				isError: false,
				timestamp: 1,
			},
			{ id: "tool-1", call },
		);
		const assistant = toProtocolAssistantMessage(
			{
				role: "assistant",
				content: [call],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			{ id: "assistant-1" },
		);
		const decodedTool = assertValidServerPayload(tool);
		const decodedAssistant = assertValidServerPayload(assistant);
		if (decodedTool.role !== "tool" || decodedAssistant.role !== "assistant")
			throw new Error("Wrong transcript roles");
		const decodedCall = decodedAssistant.content[0];
		if (decodedCall.type !== "toolCall") throw new Error("Wrong assistant content");
		for (const value of [decodedTool.input, decodedTool.details, decodedCall.input]) {
			expect(value).toEqual(input);
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
			expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
		}
	});

	test("rejects lossy tool input conversions", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => toProtocolJsonValue(Number.POSITIVE_INFINITY)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(1n)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(undefined)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(circular)).toThrow(TypeError);
	});

	test("rejects sparse execution data and normalizes sparse diagnostic arrays", () => {
		const sparse = new Array<unknown>(2);
		sparse[1] = "value";

		expect(() => toProtocolJsonValue(sparse)).toThrow(/undefined/i);
		expect(sanitizeProtocolDetails(sparse)).toEqual([null, "value"]);
	});
});
