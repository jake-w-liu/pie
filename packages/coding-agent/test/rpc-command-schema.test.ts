import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { expect, expectTypeOf, it } from "vitest";
import { type RpcCommand, rpcCommandSchema } from "../src/modes/rpc/rpc-types.ts";

const commands = {
	prompt: {
		type: "prompt",
		message: "hello",
		images: [{ type: "image", data: "abc", mimeType: "image/png" }],
		streamingBehavior: "steer",
	},
	steer: { type: "steer", message: "hello" },
	follow_up: { type: "follow_up", message: "hello" },
	abort: { type: "abort" },
	clear_queue: { type: "clear_queue" },
	new_session: { type: "new_session", parentSession: "parent.jsonl" },
	get_state: { type: "get_state" },
	set_model: { type: "set_model", provider: "faux", modelId: "faux-1" },
	cycle_model: { type: "cycle_model" },
	get_available_models: { type: "get_available_models" },
	set_thinking_level: { type: "set_thinking_level", level: "max" },
	cycle_thinking_level: { type: "cycle_thinking_level" },
	get_available_thinking_levels: { type: "get_available_thinking_levels" },
	set_steering_mode: { type: "set_steering_mode", mode: "all" },
	set_follow_up_mode: { type: "set_follow_up_mode", mode: "one-at-a-time" },
	compact: { type: "compact", customInstructions: "focus" },
	set_auto_compaction: { type: "set_auto_compaction", enabled: false },
	set_auto_retry: { type: "set_auto_retry", enabled: true },
	abort_retry: { type: "abort_retry" },
	bash: { type: "bash", command: "echo hello", excludeFromContext: false },
	abort_bash: { type: "abort_bash" },
	get_session_stats: { type: "get_session_stats" },
	export_html: { type: "export_html", outputPath: "export.html" },
	switch_session: { type: "switch_session", sessionPath: "session.jsonl" },
	fork: { type: "fork", entryId: "entry" },
	clone: { type: "clone" },
	get_fork_messages: { type: "get_fork_messages" },
	get_entries: { type: "get_entries", since: "entry" },
	get_tree: { type: "get_tree" },
	get_last_assistant_text: { type: "get_last_assistant_text" },
	set_session_name: { type: "set_session_name", name: "named" },
	get_messages: { type: "get_messages" },
	get_commands: { type: "get_commands" },
} satisfies { [K in RpcCommand["type"]]: Extract<RpcCommand, { type: K }> };

it.each(Object.entries(commands))("accepts the %s command with and without a correlation id", (_type, command) => {
	expect(Check(rpcCommandSchema, command)).toBe(true);
	expect(Check(rpcCommandSchema, { ...command, id: "correlated" })).toBe(true);
});

it("preserves agent thinking-level and image-content contracts", () => {
	expectTypeOf<Extract<RpcCommand, { type: "set_thinking_level" }>["level"]>().toEqualTypeOf<ThinkingLevel>();
	expectTypeOf<NonNullable<Extract<RpcCommand, { type: "prompt" }>["images"]>[number]>().toEqualTypeOf<ImageContent>();
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		expect(Check(rpcCommandSchema, { type: "set_thinking_level", level })).toBe(true);
	}
	expect(Check(rpcCommandSchema, { type: "prompt", message: "", streamingBehavior: "followUp" })).toBe(true);
	expect(Check(rpcCommandSchema, { type: "prompt", message: "" })).toBe(true);
	expect(Check(rpcCommandSchema, { type: "prompt", message: "", images: [] })).toBe(true);
});
