import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

it.each(["collect-first", "idle-first"])("settles simultaneous RPC event waiters in %s order", async (order) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-event-waiters-"));
	const childPath = join(dir, "child.mjs");
	writeFileSync(
		childPath,
		`import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`,
	);
	const client = new RpcClient({ cliPath: childPath });
	try {
		await client.start();
		vi.useFakeTimers();
		const waiters =
			order === "collect-first"
				? [client.collectEvents(1000), client.waitForIdle(1000)]
				: [client.waitForIdle(1000), client.collectEvents(1000)];
		const outcomes = Promise.allSettled(waiters);
		const terminal = new Promise<void>((resolve) => {
			client.onEvent((event) => {
				if (event.type === "agent_settled") resolve();
			});
		});
		await client.prompt("one terminal event");
		await terminal;
		await vi.advanceTimersByTimeAsync(1000);
		const result = await outcomes;
		expect(result.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(result[order === "collect-first" ? 0 : 1]).toEqual({
			status: "fulfilled",
			value: [{ type: "agent_settled" }],
		});
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rejects server failures consistently for every void command and still accepts success", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-command-errors-"));
	const childPath = join(dir, "child.mjs");
	writeFileSync(
		childPath,
		`import { createInterface } from "node:readline";
const seen = new Set();
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	const success = seen.has(command.type);
	seen.add(command.type);
	process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success, ...(success ? {} : { error: "rejected " + command.type }) }) + "\\n");
	if (command.type === "prompt" && success) process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`,
	);
	const client = new RpcClient({ cliPath: childPath });
	try {
		await client.start();
		const commands: Array<[string, () => Promise<void>]> = [
			["prompt", () => client.prompt("test")],
			["steer", () => client.steer("test")],
			["follow_up", () => client.followUp("test")],
			["abort", () => client.abort()],
			["set_thinking_level", () => client.setThinkingLevel("off")],
			["set_steering_mode", () => client.setSteeringMode("all")],
			["set_follow_up_mode", () => client.setFollowUpMode("all")],
			["set_auto_compaction", () => client.setAutoCompaction(false)],
			["set_auto_retry", () => client.setAutoRetry(false)],
			["abort_retry", () => client.abortRetry()],
			["abort_bash", () => client.abortBash()],
			["set_session_name", () => client.setSessionName("test")],
		];
		for (const [name, command] of commands) {
			await expect(command()).rejects.toThrow(`rejected ${name}`);
			await expect(command()).resolves.toBeUndefined();
		}
		await expect(client.getState()).rejects.toThrow("rejected get_state");
		// A separate failure at promptAndWait must also release its idle-event timer.
		await client.stop();
		await client.start();
		vi.useFakeTimers();
		try {
			await expect(client.promptAndWait("rejected preflight")).rejects.toThrow("rejected prompt");
			expect(vi.getTimerCount()).toBe(0);
			await expect(client.promptAndWait("accepted")).resolves.toEqual([{ type: "agent_settled" }]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	} finally {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
