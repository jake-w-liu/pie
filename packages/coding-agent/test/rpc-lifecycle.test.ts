import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";

const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function start(dialogs = false) {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-lifecycle-"));
	dirs.push(dir);
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/rpc-lifecycle.ts", import.meta.url))], {
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: dir,
			HOME: dir,
			TMPDIR: dir,
			TEMP: dir,
			TMP: dir,
			TEST_RPC_DIR: dir,
			TEST_STARTUP_DIALOGS: dialogs ? "1" : "0",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	const responses: RpcResponse[] = [];
	const methods: string[] = [];
	const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
	attachJsonlLineReader(child.stdout, (line) => {
		const value = JSON.parse(line);
		if (value.type === "response") responses.push(value);
		if (value.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(value.method)) {
			methods.push(value.method);
			send({
				type: "extension_ui_response",
				id: value.id,
				...(value.method === "confirm"
					? { confirmed: true }
					: { value: value.method === "select" ? "selected" : `${value.method} value` }),
			});
		}
	});
	let nextId = 0;
	async function request(command: object) {
		const id = `test-${nextId++}`;
		send({ ...command, id });
		await expect
			.poll(() => responses.find((r) => r.id === id) ?? (child.exitCode !== null ? stderr : undefined), {
				// Source-mode child startup competes with parallel Vitest transforms.
				timeout: 20000,
			})
			.toBeTypeOf("object");
		return responses.find((r) => r.id === id)!;
	}
	async function close() {
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		child.stdin.end();
		expect(await exited, stderr).toBe(0);
	}
	return { dir, child, methods, send, request, responses, close, stderr: () => stderr };
}

it("serves startup dialogs before initialization while gating ordinary commands", async () => {
	const host = start(true);
	const state = await host.request({ type: "get_state" }); // Sent before initialization, not after a sleep.
	expect(state).toMatchObject({ success: true, data: { sessionName: "initialized" } });
	expect(host.methods).toEqual(["confirm", "select", "input", "editor"]);
	const entries = await host.request({ type: "get_entries" });
	expect(entries).toMatchObject({
		data: {
			entries: expect.arrayContaining([
				expect.objectContaining({
					customType: "dialog-values",
					data: [true, "selected", "input value", "editor value"],
				}),
			]),
		},
	});
	await host.close();
});

it("runs one durable startup and resource-discovery side effect per replacement, none on cancellation", async () => {
	const host = start();
	const state = await host.request({ type: "get_state" });
	if (!state.success || state.command !== "get_state") throw new Error("missing state");
	const original = state.data.sessionFile;
	let starts = 1;
	const assertHooks = () => {
		const hooks = readFileSync(join(host.dir, "hooks.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(hooks.filter((h) => h.type === "start")).toHaveLength(starts);
		expect(hooks.filter((h) => h.type === "discover")).toHaveLength(starts);
	};
	assertHooks();
	for (const command of [
		{ type: "new_session" },
		{ type: "switch_session", sessionPath: original },
		{ type: "clone" },
	]) {
		expect(await host.request(command)).toMatchObject({ success: true, data: { cancelled: false } });
		starts++;
		assertHooks();
	}
	const forkMessages = await host.request({ type: "get_fork_messages" });
	if (!forkMessages.success || forkMessages.command !== "get_fork_messages") throw new Error("missing fork messages");
	expect(await host.request({ type: "fork", entryId: forkMessages.data.messages[0].entryId })).toMatchObject({
		success: true,
		data: { cancelled: false },
	});
	starts++;
	assertHooks();
	for (const command of [
		{ type: "fork", entryId: "cancel" },
		{ type: "switch_session", sessionPath: "cancel" },
	]) {
		expect(await host.request(command)).toMatchObject({ success: true, data: { cancelled: true } });
		assertHooks();
	}
	await host.close();
});

it("rejects null, scalars, arrays, and malformed envelopes without losing the RPC process", async () => {
	const host = start();
	await host.request({ type: "get_state" });
	const invalid = [null, false, 1, "get_state", [], {}, { type: null }, { type: [] }, { type: "get_state", id: 42 }];
	for (const value of invalid) host.send(value);
	host.child.stdin.write("{broken json\n");
	const state = await host.request({ type: "get_state" });
	expect(state).toMatchObject({ success: true });
	expect(host.responses.filter((r) => !r.success)).toHaveLength(invalid.length + 1);
	expect(host.stderr()).not.toContain("Unhandled");
	for (const malformed of [
		{ type: "set_session_name" },
		{ type: "set_auto_compaction", enabled: "false" },
		{ type: "set_auto_retry", enabled: null },
		{ type: "set_steering_mode", mode: "invalid" },
		{ type: "set_follow_up_mode", mode: [] },
		{ type: "set_thinking_level", level: 42 },
		{ type: "prompt", message: "hello", images: [null] },
		{ type: "new_session", parentSession: 42 },
		{ type: "get_entries", since: {} },
	]) {
		expect(await host.request(malformed)).toMatchObject({ success: false });
	}
	expect(await host.request({ type: "get_state" })).toMatchObject({
		success: true,
		data: {
			sessionName: "initialized",
			autoCompactionEnabled: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
		},
	});
	await host.close();
});
