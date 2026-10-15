import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../runs/shared/pi-args.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, POLL_INTERVAL_MS, TEMP_ROOT_DIR, type IntercomEventBus, type SubagentState } from "../shared/types.ts";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { shouldUseNativeFsWatch } from "../shared/watch-strategy.ts";

const SUPERVISOR_CHANNEL_ROOT = path.join(TEMP_ROOT_DIR, "supervisor-channels");
const REQUESTS_DIR = "requests";
const REPLIES_DIR = "replies";
export const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
/** Lets the user answer a subagent question directly instead of through the agent. */
export const USER_REPLY_COMMAND = "subagent-reply";
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
const CHANNEL_SAFETY_POLL_MS = 5000;
const STALE_EMPTY_CHANNEL_AGE_MS = 60 * 1000;
const STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 1000;

type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

interface SupervisorRequest {
	type: "subagent.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
	interview?: unknown;
	/**
	 * Pid of the asking child process. When present, the request stays answerable for as long as
	 * that process lives: the child stops blocking at `expiresAt` but keeps watching for a late
	 * reply and delivers it to its session as a steering message.
	 */
	childPid?: number;
}

interface PendingSupervisorRequest extends SupervisorRequest {
	channelDir: string;
	requestFile: string;
}

interface SupervisorReply {
	type: "subagent.supervisor.reply";
	requestId: string;
	createdAt: number;
	message: string;
}

interface ContactSupervisorParams {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
}

interface IntercomParams {
	action: "list" | "send" | "ask" | "reply" | "pending" | "status";
	to?: string;
	message?: string;
	replyTo?: string;
}

type SupervisorWatch = (filename: fs.PathLike, listener: fs.WatchListener<string>) => fs.FSWatcher;

interface NativeSupervisorChannelDeps {
	platform?: NodeJS.Platform;
	watch?: SupervisorWatch;
	timers?: Pick<typeof globalThis, "setInterval" | "clearInterval" | "setImmediate" | "clearImmediate">;
}

const ContactSupervisorParamsSchema = Type.Object({
	reason: Type.String({ enum: ["need_decision", "interview_request", "progress_update"] }),
	message: Type.Optional(Type.String()),
	interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
}, { additionalProperties: false });

const IntercomParamsSchema = Type.Object({
	action: Type.String({ enum: ["list", "send", "ask", "reply", "pending", "status"] }),
	to: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
}, { additionalProperties: false });

function safeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function ensureSupervisorChannelDir(channelDir: string): void {
	fs.mkdirSync(path.join(channelDir, REQUESTS_DIR), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, REPLIES_DIR), { recursive: true, mode: 0o700 });
}

function requestPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REQUESTS_DIR, `${safeSegment(requestId)}.json`);
}

function replyPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REPLIES_DIR, `${safeSegment(requestId)}.json`);
}

function readTextEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function readChildMetadata(): {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	childTarget?: string;
} | undefined {
	const channelDir = readTextEnv(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV);
	const runId = readTextEnv(SUBAGENT_RUN_ID_ENV);
	const agent = readTextEnv(SUBAGENT_CHILD_AGENT_ENV);
	const rawIndex = readTextEnv(SUBAGENT_CHILD_INDEX_ENV);
	const orchestratorSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV);
	if (!channelDir || !runId || !agent || !orchestratorSessionId || rawIndex === undefined || !/^\d+$/.test(rawIndex)) return undefined;
	return {
		channelDir,
		runId,
		agent,
		childIndex: Number(rawIndex),
		orchestratorTarget: readTextEnv(SUBAGENT_ORCHESTRATOR_TARGET_ENV),
		orchestratorSessionId,
		childTarget: readTextEnv("PI_SUBAGENT_INTERCOM_SESSION_NAME"),
	};
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function formatChildMessage(input: {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
}): string {
	const lines = [
		reasonHeading(input.reason),
		`Run: ${input.runId}`,
		`Agent: ${input.agent}`,
		`Child index: ${input.childIndex}`,
	];
	if (input.childTarget) lines.push(`Child intercom target: ${input.childTarget}`);
	lines.push("");
	if (input.message?.trim()) lines.push(input.message.trim());
	if (input.reason === "interview_request") {
		lines.push(
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
		);
		if (input.interview !== undefined) lines.push(JSON.stringify(input.interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

function parseStructuredReply(message: string): { value?: unknown; error?: string } {
	const trimmed = message.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	try {
		return { value: JSON.parse(fenced ?? trimmed) };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function askTimeoutMs(): number {
	const parsed = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Supervisor request cancelled."));
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReply(channelDir: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<SupervisorReply> {
	const file = replyPath(channelDir, requestId);
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
			if (parsed.type === "subagent.supervisor.reply" && parsed.requestId === requestId && typeof parsed.message === "string") {
				// Consume the reply so it does not linger as an orphan; the
				// periodic sweeper reaps any leftovers from crashed readers.
				try {
					fs.rmSync(file, { force: true });
				} catch {
					// Delivery already succeeded; stale-file cleanup is best-effort.
				}
				return parsed as SupervisorReply;
			}
		}
		await delay(250, signal);
	}
	throw new SupervisorReplyTimeoutError();
}

class SupervisorReplyTimeoutError extends Error {
	constructor() {
		super("Timed out waiting for supervisor reply.");
		this.name = "SupervisorReplyTimeoutError";
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function formatAskTimeout(ms: number): string {
	const minutes = ms / 60_000;
	return Number.isInteger(minutes) ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
}

const LATE_REPLY_POLL_MS = 1000;

/**
 * After the blocking wait gave up, keep watching for the supervisor's reply for the rest of
 * this process's life and hand it to the session as a steering message. The request file stays
 * in place so the parent can still answer; the parent drops it once this process is gone.
 */
function watchForLateReply(pi: ExtensionAPI, channelDir: string, requestId: string): void {
	const file = replyPath(channelDir, requestId);
	const timer = setInterval(() => {
		let reply: Partial<SupervisorReply>;
		try {
			if (!fs.existsSync(file)) {
				// The parent can no longer answer once the request is gone (run ended, cleaned up).
				// writeReply writes the reply before removing the request, so check the reply again
				// after seeing the request gone: both steps can land between the two checks above.
				if (fs.existsSync(requestPath(channelDir, requestId)) || fs.existsSync(file)) return;
				clearInterval(timer);
				return;
			}
			reply = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
		} catch {
			return; // A partially visible write is retried on the next tick.
		}
		if (reply.type !== "subagent.supervisor.reply" || reply.requestId !== requestId || typeof reply.message !== "string") return;
		clearInterval(timer);
		removeRequestFile(file);
		removeRequestFile(requestPath(channelDir, requestId));
		try {
			pi.sendMessage(
				{
					customType: "subagent_supervisor_late_reply",
					content: `**Late reply from supervisor** to your earlier contact_supervisor request ${requestId}:\n${reply.message}\n\nRe-check any assumption you made while waiting against this reply.`,
					display: true,
					details: { requestId },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch (error) {
			console.error(`Failed to deliver late supervisor reply ${requestId}:`, error);
		}
	}, LATE_REPLY_POLL_MS);
	timer.unref?.();
}

async function sendSupervisorRequest(pi: ExtensionAPI, params: ContactSupervisorParams, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
	const metadata = readChildMetadata();
	if (!metadata) throw new Error("Native supervisor channel is not available for this subagent.");
	if (params.reason !== "progress_update" && !params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions.");
	}
	ensureSupervisorChannelDir(metadata.channelDir);
	const requestId = randomUUID();
	const expectsReply = params.reason !== "progress_update";
	const createdAt = Date.now();
	const timeoutMs = askTimeoutMs();
	const replyDeadline = createdAt + timeoutMs;
	const expiresAt = expectsReply ? replyDeadline : undefined;
	const message = formatChildMessage({ ...metadata, reason: params.reason, message: params.message, interview: params.interview });
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		...(expiresAt !== undefined ? { expiresAt } : {}),
		reason: params.reason,
		message,
		expectsReply,
		...(metadata.orchestratorTarget ? { orchestratorTarget: metadata.orchestratorTarget } : {}),
		...(metadata.orchestratorSessionId ? { orchestratorSessionId: metadata.orchestratorSessionId } : {}),
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
		...(metadata.childTarget ? { childTarget: metadata.childTarget } : {}),
		...(params.interview !== undefined ? { interview: params.interview } : {}),
		...(expectsReply ? { childPid: process.pid } : {}),
	};
	const serialized = JSON.stringify(request, null, "\t");
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Supervisor request is too large.");
	writeAtomicJson(requestPath(metadata.channelDir, requestId), request);

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: "Supervisor progress update queued." }],
			details: { delivered: true, requestId, reason: params.reason },
		};
	}

	try {
		const reply = await waitForReply(metadata.channelDir, requestId, replyDeadline, signal);
		const details: Record<string, unknown> = { requestId, reason: params.reason };
		if (params.reason === "interview_request") {
			const structured = parseStructuredReply(reply.message);
			if (structured.error) details.structuredReplyParseError = structured.error;
			else details.structuredReply = structured.value;
		}
		return {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.message}` }],
			details,
		};
	} catch (error) {
		if (signal?.aborted || !(error instanceof SupervisorReplyTimeoutError)) {
			// Cancelled: nobody will consume a reply. Remove a reply that landed meanwhile too,
			// so a late parent write cannot orphan a file.
			removeRequestFile(requestPath(metadata.channelDir, requestId));
			removeRequestFile(replyPath(metadata.channelDir, requestId));
			throw error;
		}
		watchForLateReply(pi, metadata.channelDir, requestId);
		throw new Error(
			`No supervisor reply within ${formatAskTimeout(timeoutMs)} (request ${requestId}). Continue with your best judgment and state the assumption you made. If the supervisor answers later, the reply arrives as a message in this conversation.`,
		);
	}
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

export function registerNativeSupervisorClient(pi: ExtensionAPI): void {
	if (!readChildMetadata() || hasTool(pi, "contact_supervisor")) return;
	const tool: ToolDefinition<typeof ContactSupervisorParamsSchema, Record<string, unknown>> = {
		name: "contact_supervisor",
		label: "Contact Supervisor",
		description: `Contact the parent/supervisor session for a blocking decision, structured interview, or progress update. Decisions and interviews block for up to ${formatAskTimeout(askTimeoutMs())}; a later reply still arrives as a message.`,
		parameters: ContactSupervisorParamsSchema,
		execute(_id, params, signal) {
			return sendSupervisorRequest(pi, params as ContactSupervisorParams, signal);
		},
	};
	pi.registerTool(tool);
}

function parseRequestFile(file: string, channelDir: string): PendingSupervisorRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorRequest>;
		if (parsed.type !== "subagent.supervisor.request") return undefined;
		if (typeof parsed.id !== "string" || !parsed.id) return undefined;
		if (parsed.reason !== "need_decision" && parsed.reason !== "interview_request" && parsed.reason !== "progress_update") return undefined;
		if (typeof parsed.message !== "string" || !parsed.message) return undefined;
		if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number") return undefined;
		if (parsed.childPid !== undefined && !(Number.isSafeInteger(parsed.childPid) && parsed.childPid > 0)) return undefined;
		return { ...parsed as SupervisorRequest, channelDir, requestFile: file };
	} catch {
		return undefined;
	}
}

function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(SUPERVISOR_CHANNEL_ROOT, entry.name);
		const requestsDir = path.join(channelDir, REQUESTS_DIR);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(requestsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json")) files.push({ channelDir, file: path.join(requestsDir, requestEntry.name) });
		}
	}
	return files;
}

function readDirectoryEntries(dir: string): fs.Dirent[] | undefined {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return undefined;
	}
}

function directoryMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function removeEmptyDirectory(dir: string): boolean {
	try {
		fs.rmdirSync(dir);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EBUSY") return false;
		throw error;
	}
}

function removeStaleEmptySupervisorChannel(channelDir: string, nowMs: number): boolean {
	const requestsDir = path.join(channelDir, REQUESTS_DIR);
	const repliesDir = path.join(channelDir, REPLIES_DIR);
	const newestKnownMtimeMs = Math.max(
		directoryMtimeMs(channelDir),
		directoryMtimeMs(requestsDir),
		directoryMtimeMs(repliesDir),
	);
	if (nowMs - newestKnownMtimeMs < STALE_EMPTY_CHANNEL_AGE_MS) return false;

	const requestEntries = readDirectoryEntries(requestsDir);
	if (!requestEntries || requestEntries.length > 0) return false;
	const replyEntries = readDirectoryEntries(repliesDir);
	if (!replyEntries || replyEntries.length > 0) return false;

	if (!removeEmptyDirectory(requestsDir)) return false;
	if (!removeEmptyDirectory(repliesDir)) return false;
	if (!removeEmptyDirectory(channelDir)) return false;
	return true;
}

function fileMtimeMs(file: string): number | undefined {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Reap channel files no waiter can still consume: replies whose request is gone
 * and whose waiter deadline has passed, and expectsReply requests whose own
 * expiry has passed. Fire-and-forget progress updates are never reaped here;
 * they are drained on the next ingest with UI context.
 */
function reapOrphanedSupervisorFiles(channelDir: string, nowMs: number): void {
	const requestsDir = path.join(channelDir, REQUESTS_DIR);
	const repliesDir = path.join(channelDir, REPLIES_DIR);
	const requestNames = new Set((readDirectoryEntries(requestsDir) ?? []).map((entry) => entry.name));
	for (const entry of readDirectoryEntries(repliesDir) ?? []) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		if (requestNames.has(entry.name)) continue;
		const file = path.join(repliesDir, entry.name);
		const mtime = fileMtimeMs(file);
		// The waiter polls until request.createdAt + askTimeout; a reply older
		// than a full ask timeout with no request left cannot be consumed.
		if (mtime === undefined || nowMs - mtime <= askTimeoutMs()) continue;
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Opportunistic; retried on the next pass.
		}
	}
	for (const entry of readDirectoryEntries(requestsDir) ?? []) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = path.join(requestsDir, entry.name);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.type !== "subagent.supervisor.request" || parsed.expectsReply !== true) continue;
		if (typeof parsed.childPid === "number") {
			// Answerable while the asking process lives (it watches for late replies).
			if (processAlive(parsed.childPid)) continue;
			try {
				fs.rmSync(file, { force: true });
			} catch {
				// Opportunistic; retried on the next pass.
			}
			continue;
		}
		const expiresAt = typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)
			? parsed.expiresAt
			: typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
				? parsed.createdAt + askTimeoutMs()
				: undefined;
		if (expiresAt === undefined || nowMs <= expiresAt) continue;
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Opportunistic; retried on the next pass.
		}
	}
}

function cleanupStaleEmptySupervisorChannels(nowMs = Date.now()): number {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let removed = 0;
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		try {
			reapOrphanedSupervisorFiles(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name), nowMs);
		} catch {
			// Reaping is opportunistic; the empty-channel pass below still runs.
		}
		try {
			if (removeStaleEmptySupervisorChannel(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name), nowMs)) removed++;
		} catch {
			// Cleanup is opportunistic; active writers can race with us and will be picked up by a later pass.
		}
	}
	return removed;
}

function currentContextSessionId(state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): string | undefined {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) return sessionId;
	} catch {
		// Fall through to the last known identity.
	}
	return state.currentSessionId ?? undefined;
}

function requestMatchesContext(request: SupervisorRequest, state: Pick<SubagentState, "currentSessionId">, ctx: ExtensionContext): boolean {
	const currentSessionId = currentContextSessionId(state, ctx);
	return Boolean(currentSessionId && request.orchestratorSessionId === currentSessionId);
}

function rememberedForegroundChild(request: SupervisorRequest, state: SubagentState) {
	const run = state.foregroundRuns?.get(request.runId);
	const child = run?.children.find((candidate) => candidate.index === request.childIndex && candidate.agent === request.agent)
		?? run?.children[request.childIndex];
	return run && child ? { run, child } : undefined;
}

function markForegroundSupervisorAttention(request: SupervisorRequest, state: SubagentState): void {
	const remembered = rememberedForegroundChild(request, state);
	if (!remembered || remembered.child.status !== "detached") return;
	const updatedAt = Date.now();
	remembered.run.updatedAt = updatedAt;
	remembered.child.activityState = "needs_attention";
	remembered.child.lastActivityAt = request.createdAt;
	remembered.child.currentTool = "contact_supervisor";
	remembered.child.currentToolStartedAt = request.createdAt;
	remembered.child.updatedAt = updatedAt;
}

function clearForegroundSupervisorAttention(request: SupervisorRequest, pending: Map<string, PendingSupervisorRequest>, state: SubagentState): void {
	if ([...pending.values()].some((candidate) =>
		candidate.expectsReply
		&& candidate.runId === request.runId
		&& candidate.agent === request.agent
		&& candidate.childIndex === request.childIndex
	)) return;
	const remembered = rememberedForegroundChild(request, state);
	if (!remembered || remembered.child.status !== "detached") return;
	const updatedAt = Date.now();
	remembered.run.updatedAt = updatedAt;
	remembered.child.activityState = undefined;
	remembered.child.lastActivityAt = updatedAt;
	remembered.child.currentTool = undefined;
	remembered.child.currentToolStartedAt = undefined;
	remembered.child.updatedAt = updatedAt;
}

function removeRequestFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Request cleanup is best-effort; reply files and timeout errors remain authoritative.
	}
}

type SupervisorRequestLifecycle = "pending" | "resolved" | "expired" | "inactive" | "missing" | "wrong-session";

function requestExpiresAt(request: SupervisorRequest, now: number): number {
	const expiresAt = (request as { expiresAt?: unknown }).expiresAt;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt;
	return Number.isFinite(request.createdAt) ? request.createdAt + askTimeoutMs() : now;
}

function requestRunInactive(request: SupervisorRequest, state: SubagentState): boolean {
	// A remembered foreground child is authoritative about liveness: only a
	// still-detached child can consume a reply. Check it before the control
	// map, whose entry can linger after the run itself has ended.
	const foreground = rememberedForegroundChild(request, state);
	if (foreground) return foreground.child.status !== "detached";
	if (state.foregroundControls.has(request.runId)) return false;

	const asyncJob = state.asyncJobs.get(request.runId) ?? state.fleetJobs?.get(request.runId);
	// An untracked run id means the run (and any waiter) is already gone;
	// leaving the request pending would wait forever.
	if (!asyncJob) return true;
	if (asyncJob.status === "complete" || asyncJob.status === "failed" || asyncJob.status === "paused" || asyncJob.status === "stopped" || asyncJob.status === "rejected") return true;
	const stepStatus = asyncJob.steps?.[request.childIndex]?.status;
	return stepStatus === "complete" || stepStatus === "completed" || stepStatus === "failed" || stepStatus === "paused" || stepStatus === "stopped" || stepStatus === "rejected";
}

function requestLifecycle(request: PendingSupervisorRequest, state: SubagentState, ctx: ExtensionContext | undefined, now: number): SupervisorRequestLifecycle {
	if (ctx && !requestMatchesContext(request, state, ctx)) return "wrong-session";
	if (!fs.existsSync(request.requestFile)) return "missing";
	if (request.expectsReply && fs.existsSync(replyPath(request.channelDir, request.id))) return "resolved";
	if (request.expectsReply && request.childPid !== undefined) {
		if (!processAlive(request.childPid)) return "inactive";
	} else if (request.expectsReply && now > requestExpiresAt(request, now)) {
		return "expired";
	}
	if (request.expectsReply && requestRunInactive(request, state)) return "inactive";
	return "pending";
}

function cleanupRequestLifecycle(request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle): void {
	if (lifecycle === "resolved" || lifecycle === "expired" || lifecycle === "inactive") removeRequestFile(request.requestFile);
}

function refreshPendingRequests(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, ctx: ExtensionContext | undefined): void {
	const now = Date.now();
	for (const request of pending.values()) {
		const lifecycle = requestLifecycle(request, state, ctx, now);
		if (lifecycle === "pending") continue;
		pending.delete(request.id);
		cleanupRequestLifecycle(request, lifecycle);
	}
}

function stoppedWaiting(request: SupervisorRequest, now = Date.now()): boolean {
	return request.expiresAt !== undefined && now > request.expiresAt;
}

function formatPendingLine(request: PendingSupervisorRequest): string {
	const replyHint = request.expectsReply ? ` Reply: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })` : "";
	const late = request.expectsReply && stoppedWaiting(request) ? " (stopped blocking; a reply is delivered as a message)" : "";
	return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}${late}.${replyHint}`;
}

function requestVisibleText(request: PendingSupervisorRequest, askUserAvailable: boolean): string {
	const lines = [request.message];
	if (request.expectsReply) {
		if (request.expiresAt !== undefined) {
			const until = new Date(request.expiresAt).toLocaleTimeString();
			lines.push(
				"",
				request.childPid !== undefined
					? `The subagent blocks on this until ${until}, then continues on its own assumption; a later reply is still delivered while it runs.`
					: `The subagent waits for this reply until ${until}.`,
			);
		}
		lines.push("", `Reply with: ${NATIVE_SUPERVISOR_TOOL_NAME}({ action: "reply", replyTo: "${request.id}", message: "..." })`);
		if (askUserAvailable) lines.push("If the decision should come from the user, ask them with ask_user and relay the answer.");
		lines.push(`The user can also answer directly: /${USER_REPLY_COMMAND} ${request.id.slice(0, 8)} <answer>`);
	}
	return lines.join("\n");
}

function writeReply(request: PendingSupervisorRequest, message: string): void {
	if (!message.trim()) throw new Error("message is required for supervisor replies.");
	const reply: SupervisorReply = {
		type: "subagent.supervisor.reply",
		requestId: request.id,
		createdAt: Date.now(),
		message: message.trim(),
	};
	writeAtomicJson(replyPath(request.channelDir, request.id), reply);
	removeRequestFile(request.requestFile);
}

/** Who answered recently resolved requests, so a second answer gets a precise error. Bounded. */
type AnsweredRequests = Map<string, { by: "user" | "agent"; agent: string }>;
const MAX_REMEMBERED_ANSWERS = 256;
/**
 * Shortest request-id prefix accepted as a target: the length the notice shows. Shorter prefixes
 * (a single digit matches about one id in sixteen) would capture the first word of an answer.
 */
const MIN_REQUEST_ID_PREFIX = 8;

function rememberAnswer(answered: AnsweredRequests, request: PendingSupervisorRequest, by: "user" | "agent"): void {
	answered.set(request.id, { by, agent: request.agent });
	if (answered.size > MAX_REMEMBERED_ANSWERS) answered.delete(answered.keys().next().value!);
}

/** Requests matching a request-id prefix (8+ characters), agent name, or child intercom target. */
function matchPendingRequests(requests: PendingSupervisorRequest[], target: string): PendingSupervisorRequest[] {
	const normalized = target.toLowerCase();
	return requests.filter((request) =>
		(normalized.length >= MIN_REQUEST_ID_PREFIX && request.id.toLowerCase().startsWith(normalized))
		|| request.agent.toLowerCase() === normalized
		|| request.childTarget?.toLowerCase() === normalized,
	);
}

/** A precise reason why nothing is waiting for `target`, when the user already answered it. */
function alreadyAnsweredNote(answered: AnsweredRequests, target: string): string {
	const normalized = target.toLowerCase();
	// Newest first: the most recent answer is the one the caller is most likely asking about.
	for (const [id, entry] of [...answered].reverse()) {
		if (id.toLowerCase() === normalized || (normalized.length >= MIN_REQUEST_ID_PREFIX && id.toLowerCase().startsWith(normalized)) || entry.agent.toLowerCase() === normalized) {
			return ` Request ${id} from ${entry.agent} was already answered by the ${entry.by}.`;
		}
	}
	return "";
}

function resolvePendingRequest(pending: Map<string, PendingSupervisorRequest>, params: IntercomParams, answered: AnsweredRequests): PendingSupervisorRequest {
	if (params.replyTo) {
		const request = pending.get(params.replyTo);
		if (!request) {
			const entry = answered.get(params.replyTo);
			if (entry) throw new Error(`Supervisor request '${params.replyTo}' was already answered by the ${entry.by}; no further reply is needed.`);
			throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
		}
		return request;
	}
	const requests = [...pending.values()].filter((request) => request.expectsReply);
	if (params.to) {
		const matches = matchPendingRequests(requests, params.to);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Multiple pending supervisor requests match '${params.to}'. Use replyTo.`);
		// Never fall back to some other request: that would deliver this answer to the wrong subagent.
		throw new Error(`No pending supervisor request matches '${params.to}'.${alreadyAnsweredNote(answered, params.to)}`);
	}
	if (requests.length === 1) return requests[0]!;
	if (requests.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

/** Send an answer to a pending request; shared by the agent's tool and the user's command. */
function answerPendingRequest(
	request: PendingSupervisorRequest,
	message: string,
	by: "user" | "agent",
	pending: Map<string, PendingSupervisorRequest>,
	answered: AnsweredRequests,
	state: SubagentState,
): { late: boolean } {
	const late = stoppedWaiting(request);
	writeReply(request, message);
	pending.delete(request.id);
	rememberAnswer(answered, request, by);
	clearForegroundSupervisorAttention(request, pending, state);
	return { late };
}

function publicPendingRequests(pending: Map<string, PendingSupervisorRequest>): Array<Record<string, unknown>> {
	return [...pending.values()].map((request) => ({
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
	}));
}

function buildParentSupervisorTool(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, answered: AnsweredRequests): ToolDefinition<typeof IntercomParamsSchema, Record<string, unknown>> {
	return {
		name: NATIVE_SUPERVISOR_TOOL_NAME,
		label: "Subagent Supervisor",
		description: "Native pi-subagents supervisor channel. Use reply/pending/status to answer child subagent requests without overriding pi-intercom.",
		parameters: IntercomParamsSchema,
		async execute(_id, params) {
			refreshPendingRequests(pending, state, state.lastUiContext ?? undefined);
			const input = params as IntercomParams;
			if (input.action === "status") {
				return { content: [{ type: "text", text: `Native supervisor channel active. Pending replies: ${pending.size}.` }], details: { active: true, pending: pending.size, root: SUPERVISOR_CHANNEL_ROOT } };
			}
			if (input.action === "pending" || input.action === "list") {
				const lines = [...pending.values()].filter((request) => request.expectsReply).map(formatPendingLine);
				return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending supervisor requests." }], details: { pending: publicPendingRequests(pending) } };
			}
			if (input.action === "reply") {
				const request = resolvePendingRequest(pending, input, answered);
				const { late } = answerPendingRequest(request, input.message ?? "", "agent", pending, answered, state);
				const text = late
					? `Replied to supervisor request ${request.id}. The subagent had stopped blocking on it, so it receives the reply as a steering message.`
					: `Replied to supervisor request ${request.id}.`;
				return { content: [{ type: "text", text }], details: { replyTo: request.id, runId: request.runId, agent: request.agent, late } };
			}
			if (input.action === "send" || input.action === "ask") {
				throw new Error("The native subagent supervisor handles replies only. Child agents initiate asks with contact_supervisor.");
			}
			throw new Error(`Unsupported supervisor action: ${input.action}`);
		},
	};
}

/** First line of the child's own question, for dialog titles. */
function questionSummary(request: PendingSupervisorRequest): string {
	const lines = request.message.split("\n");
	// formatChildMessage puts a heading and metadata lines before a blank line, then the question.
	const blank = lines.indexOf("");
	const question = (blank >= 0 ? lines.slice(blank + 1) : lines).find((line) => line.trim())?.trim() ?? request.reason;
	return question.length > 120 ? `${question.slice(0, 119)}…` : question;
}

async function answerAsUser(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
	pending: Map<string, PendingSupervisorRequest>,
	answered: AnsweredRequests,
	state: SubagentState,
): Promise<void> {
	refreshPendingRequests(pending, state, ctx);
	const open = [...pending.values()].filter((request) => request.expectsReply);
	const notify = (message: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else console.error(message);
	};
	if (open.length === 0) {
		notify("No subagent is waiting for an answer.", "info");
		return;
	}

	let request: PendingSupervisorRequest | undefined;
	let message: string | undefined;
	const trimmed = args.trim();
	if (trimmed) {
		// "<request-id> <answer>" always; "<agent> <answer>" only to choose among several waiting
		// subagents. With one waiting, the whole text is the answer, so it may start with any word.
		const firstWord = trimmed.split(/\s+/, 1)[0]!;
		const first = firstWord.toLowerCase();
		// Cut by the original word: lowercasing can change the length (for example "İ").
		const rest = trimmed.slice(firstWord.length).trim();
		const idMatches = first.length >= MIN_REQUEST_ID_PREFIX ? open.filter((candidate) => candidate.id.toLowerCase().startsWith(first)) : [];
		const nameMatches = open.filter(
			(candidate) => candidate.agent.toLowerCase() === first || candidate.childTarget?.toLowerCase() === first,
		);
		if (idMatches.length === 1) {
			request = idMatches[0];
			message = rest || undefined;
		} else if (open.length === 1) {
			request = open[0];
			message = trimmed;
		} else if (nameMatches.length === 1) {
			request = nameMatches[0];
			message = rest || undefined;
		} else {
			const ids = open.map((candidate) => `${candidate.id.slice(0, 8)} (${candidate.agent})`).join(", ");
			notify(
				nameMatches.length > 1
					? `Several waiting subagents are named '${first}'; start with a request id: ${ids}.`
					: `Several subagents are waiting (${ids}); start with a request id or agent name.`,
				"warning",
			);
			return;
		}
	} else {
		if (!ctx.hasUI) {
			notify(`Usage: /${USER_REPLY_COMMAND} <answer>, or /${USER_REPLY_COMMAND} <request-id|agent> <answer> when several subagents are waiting`, "warning");
			return;
		}
		if (open.length === 1) {
			request = open[0];
		} else {
			const labels = open.map((candidate) => `${candidate.agent} (${candidate.id.slice(0, 8)}): ${questionSummary(candidate)}`);
			const picked = await ctx.ui.select("Which subagent do you want to answer?", labels);
			if (picked === undefined) return;
			request = open[labels.indexOf(picked)];
		}
	}
	if (!request) return;
	if (!message?.trim()) {
		// A target without an answer: ask for the answer.
		if (!ctx.hasUI) {
			notify(`Usage: /${USER_REPLY_COMMAND} <answer>, or /${USER_REPLY_COMMAND} <request-id|agent> <answer> when several subagents are waiting`, "warning");
			return;
		}
		message = await ctx.ui.input(`Answer ${request.agent}: ${questionSummary(request)}`, "Your answer");
	}
	if (!message?.trim()) return;
	// The request may have been answered or dropped while the dialog was open.
	refreshPendingRequests(pending, state, ctx);
	if (!pending.has(request.id)) {
		const entry = answered.get(request.id);
		notify(entry ? `That question was already answered by the ${entry.by}.` : "That subagent is no longer waiting for an answer.", "warning");
		return;
	}
	const { late } = answerPendingRequest(request, message, "user", pending, answered, state);
	// The agent saw the question; tell it the user answered so it does not answer again.
	pi.sendMessage(
		{
			customType: "subagent_supervisor_user_reply",
			content: `The user answered ${request.agent}'s question (request ${request.id}) directly: ${message.trim()}\nNo reply from you is needed for that request.`,
			display: false,
			details: { requestId: request.id, runId: request.runId, agent: request.agent },
		},
		{ deliverAs: "steer" },
	);
	notify(
		late
			? `Sent your answer to ${request.agent}; it had stopped waiting and receives it as a message.`
			: `Sent your answer to ${request.agent}.`,
		"info",
	);
}

export function createNativeSupervisorChannel(pi: ExtensionAPI, state: SubagentState, deps: NativeSupervisorChannelDeps = {}): { start: () => void; activateTransport: () => void; dispose: () => void; pending: Map<string, PendingSupervisorRequest> } {
	const watch = deps.watch ?? fs.watch;
	const timers = deps.timers ?? globalThis;
	const pending = new Map<string, PendingSupervisorRequest>();
	const answered: AnsweredRequests = new Map();
	const seenFiles = new Set<string>();
	const requestWatchers = new Map<string, fs.FSWatcher>();
	let rootWatcher: fs.FSWatcher | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let safetyPoller: ReturnType<typeof setInterval> | undefined;
	let deferredWatcherRefresh: ReturnType<typeof setImmediate> | undefined;
	let started = false;
	let lastStaleCleanupAt = 0;
	const platform = deps.platform ?? process.platform;
	const useNativeWatcher = () => shouldUseNativeFsWatch("supervisor-channel", platform) && platform !== "win32";
	const hasTransportDemand = () => {
		if (pending.size > 0) return true;
		if (state.foregroundControls.size > 0) return true;
		return [...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running");
	};

	const registerParentTools = (): void => {
		if (!hasTool(pi, NATIVE_SUPERVISOR_TOOL_NAME)) pi.registerTool(buildParentSupervisorTool(pending, state, answered));
	};
	// Registered at load, so command listings and autocomplete include it from the start.
	pi.registerCommand(USER_REPLY_COMMAND, {
		description:
			"Answer a subagent's question yourself: /subagent-reply <answer>; with several waiting, start with a request id or agent name",
		handler: (args, ctx) => answerAsUser(pi, args, ctx, pending, answered, state),
	});

	const cleanupStaleChannelsIfDue = (): void => {
		const nowMs = Date.now();
		if (nowMs - lastStaleCleanupAt < STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS) return;
		lastStaleCleanupAt = nowMs;
		try {
			cleanupStaleEmptySupervisorChannels(nowMs);
		} catch {
			// Supervisor delivery must not fail because best-effort temp cleanup failed.
		}
	};

	const poll = (): void => {
		cleanupStaleChannelsIfDue();
		const ctx = state.lastUiContext;
		if (!ctx) return;
		refreshPendingRequests(pending, state, ctx);
		const now = Date.now();
		for (const { channelDir, file } of listRequestFiles()) {
			if (seenFiles.has(file)) continue;
			const request = parseRequestFile(file, channelDir);
			if (!request || !requestMatchesContext(request, state, ctx)) continue;
			const lifecycle = requestLifecycle(request, state, undefined, now);
			if (lifecycle !== "pending") {
				seenFiles.add(file);
				cleanupRequestLifecycle(request, lifecycle);
				continue;
			}
			seenFiles.add(file);
			if (request.expectsReply) {
				pending.set(request.id, request);
				markForegroundSupervisorAttention(request, state);
			}
			else {
				removeRequestFile(request.requestFile);
			}
			pi.sendMessage({
				customType: "subagent_supervisor_request",
				content: requestVisibleText(request, hasTool(pi, "ask_user")),
				display: true,
				details: {
					id: request.id,
					reason: request.reason,
					expectsReply: request.expectsReply,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				},
			}, { triggerTurn: true });
			if (request.expectsReply) {
				(pi as { events?: IntercomEventBus }).events?.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: request.id,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				});
				if (pending.has(request.id)) markForegroundSupervisorAttention(request, state);
			}
		}
	};

	const startPolling = (): void => {
		if (poller) return;
		poller = timers.setInterval(() => {
			poll();
			if (!useNativeWatcher() && platform === "darwin" && !hasTransportDemand()) {
				if (poller) timers.clearInterval(poller);
				poller = undefined;
			}
		}, CHANNEL_POLL_MS);
		poller.unref?.();
	};
	const startSafetyPolling = (): void => {
		if (safetyPoller) return;
		safetyPoller = timers.setInterval(() => {
			watchExistingRequestDirs();
			poll();
		}, CHANNEL_SAFETY_POLL_MS);
		safetyPoller.unref?.();
	};
	const watchRequestDir = (requestsDir: string): void => {
		if (requestWatchers.has(requestsDir)) return;
		try {
			const watcher = watch(requestsDir, () => poll());
			watcher.on("error", () => {
				try { watcher.close(); } catch {}
				requestWatchers.delete(requestsDir);
				startPolling();
			});
			watcher.unref?.();
			requestWatchers.set(requestsDir, watcher);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") startPolling();
		}
	};
	const watchExistingRequestDirs = (): void => {
		let channelEntries: fs.Dirent[];
		try {
			channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			startPolling();
			return;
		}
		for (const entry of channelEntries) {
			if (entry.isDirectory()) watchRequestDir(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name, REQUESTS_DIR));
		}
	};
	const scheduleWatcherRefresh = (): void => {
		if (deferredWatcherRefresh) return;
		deferredWatcherRefresh = timers.setImmediate(() => {
			deferredWatcherRefresh = undefined;
			if (!started) return;
			watchExistingRequestDirs();
			poll();
		});
		deferredWatcherRefresh.unref?.();
	};

	return {
		activateTransport: () => {
			if (!started) return;
			poll();
			if (!useNativeWatcher() && hasTransportDemand()) startPolling();
		},
		start: () => {
			if (started) return;
			started = true;
			registerParentTools();
			poll();
			try {
				fs.mkdirSync(SUPERVISOR_CHANNEL_ROOT, { recursive: true });
				if (!useNativeWatcher()) {
					if (platform === "win32") startPolling();
					return;
				}
				watchExistingRequestDirs();
				rootWatcher = watch(SUPERVISOR_CHANNEL_ROOT, () => {
					watchExistingRequestDirs();
					poll();
					scheduleWatcherRefresh();
				});
				rootWatcher.on("error", startPolling);
				startSafetyPolling();
				scheduleWatcherRefresh();
			} catch {
				startPolling();
			}
		},
		dispose: () => {
			started = false;
			try {
				rootWatcher?.close();
			} catch {
				// Best effort during shutdown.
			}
			rootWatcher = undefined;
			for (const watcher of requestWatchers.values()) {
				try { watcher.close(); } catch {}
			}
			requestWatchers.clear();
			if (poller) timers.clearInterval(poller);
			poller = undefined;
			if (safetyPoller) timers.clearInterval(safetyPoller);
			safetyPoller = undefined;
			if (deferredWatcherRefresh) timers.clearImmediate(deferredWatcherRefresh);
			deferredWatcherRefresh = undefined;
			pending.clear();
			seenFiles.clear();
		},
		pending,
	};
}
