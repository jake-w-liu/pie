/**
 * Regression tests for the native supervisor channel: a parent that answers after the child
 * stopped blocking got "No pending supervisor request found" and the answer was lost, although
 * the child was still running. Pid-tagged requests now stay answerable while the asking process
 * lives, and the child delivers the late reply to its session as a steering message.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoot = vi.hoisted(() => {
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pi-supervisor-late-"));
	process.env.PI_SUBAGENTS_TEMP_ROOT = root;
	return root;
});

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	registerNativeSupervisorClient,
} from "../src/intercom/native-supervisor-channel.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../src/runs/shared/pi-args.ts";
import type { SubagentState } from "../src/shared/types.ts";

const SESSION_ID = "parent-session";
const RUN_ID = "run-late-reply";
const channelDir = path.join(tempRoot, "supervisor-channels", "late-reply");

type SentMessage = { message: { content: string; customType: string }; options: unknown };
type ToolLike = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

type CommandLike = { handler: (args: string, ctx: unknown) => Promise<void> };

function fakePi(sent: SentMessage[] = [], extraTools: string[] = []) {
	const tools: ToolLike[] = [];
	const commands = new Map<string, CommandLike>();
	const pi = {
		registerTool: (tool: ToolLike) => tools.push(tool),
		registerCommand: (name: string, command: CommandLike) => commands.set(name, command),
		getAllTools: () => [...tools, ...extraTools.map((name) => ({ name }))],
		sendMessage: (message: SentMessage["message"], options: unknown) => sent.push({ message, options }),
		events: { emit: () => {}, on: () => () => {} },
	};
	return { pi: pi as unknown as ExtensionAPI, tools, sent, commands };
}

function parentState(): SubagentState {
	return {
		currentSessionId: SESSION_ID,
		asyncJobs: new Map(),
		foregroundControls: new Map([[RUN_ID, {}]]),
		lastUiContext: { sessionManager: { getSessionId: () => SESSION_ID } },
	} as unknown as SubagentState;
}

async function until<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const envKeys = [
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	"PI_INTERCOM_ASK_TIMEOUT_MS",
];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
	process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
	process.env[SUBAGENT_RUN_ID_ENV] = RUN_ID;
	process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
	process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
	process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = SESSION_ID;
	process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "400";
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(channelDir, { recursive: true, force: true });
});

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("native supervisor late replies", () => {
	it("delivers a reply sent after the child stopped blocking as a steering message", async () => {
		const child = fakePi();
		registerNativeSupervisorClient(child.pi);
		const contact = child.tools.find((tool) => tool.name === "contact_supervisor");
		expect(contact).toBeDefined();

		const parentSent: SentMessage[] = [];
		const parent = fakePi(parentSent);
		const channel = createNativeSupervisorChannel(parent.pi, parentState(), { platform: "win32" });
		channel.start();
		try {
			const ask = contact!.execute("call-1", { reason: "need_decision", message: "Which branch?" }, undefined);
			const notice = await until(() => parentSent.find((sent) => sent.message.customType === "subagent_supervisor_request"));
			expect(notice.message.content).toContain("then continues on its own assumption");

			await expect(ask).rejects.toThrow(/No supervisor reply within .*If the supervisor answers later, the reply arrives/);
			const requestId = [...channel.pending.keys()][0]!;

			// The child stopped blocking; its request must still be answerable.
			const supervisor = parent.tools.find((tool) => tool.name === "subagent_supervisor")!;
			const replied = await supervisor.execute("call-2", { action: "reply", replyTo: requestId, message: "Use main." });
			expect(replied.content[0]!.text).toContain("receives the reply as a steering message");

			const delivered = await until(() =>
				child.sent.find((sent) => sent.message.customType === "subagent_supervisor_late_reply"),
			);
			expect(delivered.message.content).toContain("Use main.");
			expect(delivered.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
			expect(fs.readdirSync(path.join(channelDir, "requests"))).toEqual([]);
			expect(fs.readdirSync(path.join(channelDir, "replies"))).toEqual([]);
		} finally {
			channel.dispose();
		}
	}, 30_000);

	it("delivers a late reply written between the watcher's reply and request checks", async () => {
		const child = fakePi();
		registerNativeSupervisorClient(child.pi);
		const contact = child.tools.find((tool) => tool.name === "contact_supervisor")!;
		const error = await contact.execute("call-1", { reason: "need_decision", message: "Which DB?" }, undefined).then(
			() => undefined,
			(caught: unknown) => caught as Error,
		);
		const requestId = /request ([0-9a-f-]{36})/.exec(error?.message ?? "")?.[1];
		expect(requestId).toBeDefined();
		const requestFile = path.join(channelDir, "requests", `${requestId}.json`);
		const replyFile = path.join(channelDir, "replies", `${requestId}.json`);
		expect(fs.existsSync(requestFile)).toBe(true);

		// Land the parent's writeReply (reply first, then request removal) right after the watcher
		// found no reply, so it sees the request gone on its next check.
		const cjsFs = createRequire(import.meta.url)("node:fs") as typeof fs;
		const realExists = cjsFs.existsSync;
		let injected = false;
		cjsFs.existsSync = (candidate: fs.PathLike) => {
			const result = realExists(candidate);
			if (!injected && candidate === replyFile && !result) {
				injected = true;
				cjsFs.writeFileSync(
					replyFile,
					JSON.stringify({ type: "subagent.supervisor.reply", requestId, createdAt: Date.now(), message: "Use Postgres" }),
				);
				cjsFs.rmSync(requestFile, { force: true });
			}
			return result;
		};
		syncBuiltinESMExports();
		try {
			const delivered = await until(() =>
				child.sent.find((sent) => sent.message.customType === "subagent_supervisor_late_reply"),
			);
			expect(injected).toBe(true);
			expect(delivered.message.content).toContain("Use Postgres");
			expect(fs.existsSync(replyFile)).toBe(false);
		} finally {
			cjsFs.existsSync = realExists;
			syncBuiltinESMExports();
		}
	}, 30_000);

	it("drops a pid-tagged request once the asking process has exited", async () => {
		const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		const deadPid = Number(exited.stdout);
		expect(Number.isSafeInteger(deadPid) && deadPid > 0).toBe(true);

		ensureSupervisorChannelDir(channelDir);
		const requestFile = path.join(channelDir, "requests", "dead-child.json");
		const now = Date.now();
		fs.writeFileSync(
			requestFile,
			JSON.stringify({
				type: "subagent.supervisor.request",
				id: "dead-child",
				createdAt: now,
				expiresAt: now + 60_000,
				reason: "need_decision",
				message: "Anyone there?",
				expectsReply: true,
				orchestratorSessionId: SESSION_ID,
				runId: RUN_ID,
				agent: "worker",
				childIndex: 0,
				childPid: deadPid,
			}),
		);

		const parentSent: SentMessage[] = [];
		const parent = fakePi(parentSent);
		const channel = createNativeSupervisorChannel(parent.pi, parentState(), { platform: "win32" });
		channel.start();
		try {
			expect(channel.pending.size).toBe(0);
			expect(parentSent).toHaveLength(0);
			expect(fs.existsSync(requestFile)).toBe(false);
		} finally {
			channel.dispose();
		}
	});

	it("lets the user answer a waiting subagent directly with /subagent-reply", async () => {
		process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "20000";
		const child = fakePi();
		registerNativeSupervisorClient(child.pi);
		const contact = child.tools.find((tool) => tool.name === "contact_supervisor")!;

		const parentSent: SentMessage[] = [];
		const parent = fakePi(parentSent, ["ask_user"]);
		const state = parentState();
		const channel = createNativeSupervisorChannel(parent.pi, state, { platform: "win32" });
		channel.start();
		try {
			const ask = contact.execute("call-1", { reason: "need_decision", message: "Which branch?" }, undefined);
			const notice = await until(() => parentSent.find((sent) => sent.message.customType === "subagent_supervisor_request"));
			expect(notice.message.content).toContain("ask them with ask_user");
			expect(notice.message.content).toContain("/subagent-reply ");

			// The user picks nothing to choose (one waiting subagent) and types the answer.
			const notices: string[] = [];
			const inputs: string[] = [];
			const ui = {
				hasUI: true,
				sessionManager: { getSessionId: () => SESSION_ID },
				ui: {
					notify: (message: string) => notices.push(message),
					select: async () => {
						throw new Error("no choice needed for a single waiting subagent");
					},
					input: async (title: string) => {
						inputs.push(title);
						return "Use main.";
					},
				},
			};
			await parent.commands.get("subagent-reply")!.handler("", ui);
			expect(inputs).toEqual(["Answer worker: Which branch?"]);
			expect(notices).toEqual(["Sent your answer to worker."]);
			const reply = await ask;
			expect(reply.content[0]!.text).toContain("Use main.");

			// The agent answering the same request afterwards learns the user already did.
			const requestId = (notice.message as unknown as { details: { id: string } }).details.id;
			const supervisor = parent.tools.find((tool) => tool.name === "subagent_supervisor")!;
			await expect(
				supervisor.execute("call-2", { action: "reply", replyTo: requestId, message: "Use dev." }),
			).rejects.toThrow("already answered by the user");
		} finally {
			channel.dispose();
		}
	}, 30_000);

	it("parses /subagent-reply targets without eating answers or misrouting the agent's reply", async () => {
		process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "20000";
		const parentSent: SentMessage[] = [];
		const parent = fakePi(parentSent);
		const channel = createNativeSupervisorChannel(parent.pi, parentState(), { platform: "win32" });
		channel.start();
		const notices: string[] = [];
		const inputs: string[] = [];
		const ui = {
			hasUI: true,
			sessionManager: { getSessionId: () => SESSION_ID },
			ui: {
				notify: (message: string) => notices.push(message),
				input: async (title: string) => {
					inputs.push(title);
					return "Typed in the dialog.";
				},
			},
		};
		const reply = parent.commands.get("subagent-reply")!;
		const ask = (agent: string, question: string) => {
			process.env[SUBAGENT_CHILD_AGENT_ENV] = agent;
			const child = fakePi();
			registerNativeSupervisorClient(child.pi);
			return child.tools.find((tool) => tool.name === "contact_supervisor")!.execute(
				"call",
				{ reason: "need_decision", message: question },
				undefined,
			);
		};
		const requestFor = (agent: string) =>
			until(() => [...channel.pending.values()].find((request) => request.agent === agent));
		try {
			// One waiting subagent: the whole text is the answer, even when it starts like a target.
			const first = ask("worker", "How many retries?");
			await requestFor("worker");
			await reply.handler("1 more retries are fine", ui);
			expect((await first).content[0]!.text).toContain("1 more retries are fine");

			// A request id alone asks for the answer in a dialog.
			const second = ask("worker", "Which branch?");
			const secondRequest = await requestFor("worker");
			await reply.handler(secondRequest.id.slice(0, 8), ui);
			expect(inputs).toEqual(["Answer worker: Which branch?"]);
			expect((await second).content[0]!.text).toContain("Typed in the dialog.");

			// Two waiting: the agent name picks one; the agent is told about the user's answer.
			const third = ask("worker", "Which database?");
			const reviewer = ask("reviewer", "Strict or lenient?");
			await requestFor("worker");
			await requestFor("reviewer");
			await reply.handler("worker Postgres", ui);
			expect((await third).content[0]!.text).toContain("Postgres");
			const told = parentSent.filter((sent) => sent.message.customType === "subagent_supervisor_user_reply");
			expect(told.at(-1)).toMatchObject({ options: { deliverAs: "steer" } });
			expect(told.at(-1)!.message.content).toContain("No reply from you is needed");

			// The agent, unaware, answers the worker by name: it must not reach the reviewer.
			const supervisor = parent.tools.find((tool) => tool.name === "subagent_supervisor")!;
			await expect(supervisor.execute("call", { action: "reply", to: "worker", message: "MySQL" })).rejects.toThrow(
				/No pending supervisor request matches 'worker'\. Request .* from worker was already answered by the user/,
			);
			expect([...channel.pending.values()].map((request) => request.agent)).toEqual(["reviewer"]);
			await reply.handler("reviewer Lenient.", ui);
			expect((await reviewer).content[0]!.text).toContain("Lenient.");
		} finally {
			channel.dispose();
		}
	}, 60_000);
});
