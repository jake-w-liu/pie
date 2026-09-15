import { describe, expect, test } from "vitest";
import {
	encodeServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	ServerMessageDecoder,
	type ServerSnapshot,
} from "../src/index.ts";

const emptySnapshot: ServerSnapshot = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_VERSION,
	revision: 0,
	sessions: [],
	models: [],
};

function helloWithSessions(count: number) {
	return encodeServerMessage({
		type: "hello",
		version: PROTOCOL_VERSION,
		connectionId: "connection-1",
		snapshot: {
			...emptySnapshot,
			sessions: Array.from({ length: count }, (_, i) => ({
				id: `session-${i}`,
				createdAt: 1,
				updatedAt: 2,
				cwd: "/tmp",
			})),
		},
	});
}

describe("codec container/depth limits (C3)", () => {
	test("decodes under default limits", () => {
		const wire = helloWithSessions(3);
		const decoder = new ServerMessageDecoder();
		const messages = decoder.push(wire);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.type).toBe("hello");
	});

	test("maxContainerLength is enforced when configured", () => {
		const wire = helloWithSessions(3);
		// sessions array (3 entries) plus maps exceed a container cap of 1.
		const decoder = new ServerMessageDecoder({ maxContainerLength: 1 });
		expect(() => decoder.push(wire)).toThrow(ProtocolValidationError);
	});

	test("maxDepth is enforced when configured", () => {
		const wire = helloWithSessions(1);
		const decoder = new ServerMessageDecoder({ maxDepth: 1 });
		expect(() => decoder.push(wire)).toThrow(ProtocolValidationError);
	});

	test("larger custom limits still accept the same payload", () => {
		const wire = helloWithSessions(2);
		const decoder = new ServerMessageDecoder({ maxContainerLength: 100, maxDepth: 32 });
		const messages = decoder.push(wire);
		expect(messages).toHaveLength(1);
	});
});
