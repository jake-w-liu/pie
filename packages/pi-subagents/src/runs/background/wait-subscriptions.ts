import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { formatResumeFirstFailedRunDetail } from "./resume-guidance.ts";
import { readCompletionReplay } from "./completion-replay.ts";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import {
	DIRS,
	INTERCOM_DETACH_REQUEST_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
	type WaitCompletion,
	type WaitSubscriptionRecord,
} from "../../shared/types.ts";

const SUBSCRIPTION_VERSION = 1;
const RECONCILE_INTERVAL_MS = 1_000;
/**
 * How often the subscriptions directory is re-scanned for expired records left
 * by other sessions. Rare compared to RECONCILE_INTERVAL_MS because it costs a
 * directory read, and nothing depends on the sweep being prompt.
 */
const FOREIGN_SWEEP_INTERVAL_MS = 60_000;
/**
 * How far past expiry a record armed by another session is kept before it is
 * swept. The owning session settles its own expired records with a "timed out"
 * notice on the next restore(), so removing one the moment it expires would take
 * that notice away from a session that simply had not resumed yet. A day is long
 * enough for an ordinary return and short enough to bound the directory.
 */
const FOREIGN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const WAIT_DELIVERY_REPLAY_DIR = path.join("completion-replay", "wait-deliveries");
/**
 * A crashed claimant is retried after this lease rather than orphaning the wake.
 * Transport is intentionally at-least-once; the owning session's durable receipt
 * turns an ordinary stale-claim redelivery into a no-op.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

export interface ArmWaitSubscriptionInput {
	targetKind: "async" | "foreground";
	runId: string;
	requestedId: string;
	timeoutMs: number;
}

export interface WaitSubscriptionManager {
	arm(input: ArmWaitSubscriptionInput): WaitSubscriptionRecord;
	restore(): void;
	reconcile(): void;
	dispose(): void;
}

interface WaitSubscriptionManagerOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	subscriptionsDir?: string;
	now?: () => number;
	pollIntervalMs?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseRecord(value: unknown): WaitSubscriptionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<WaitSubscriptionRecord>;
	if (record.version !== SUBSCRIPTION_VERSION
		|| typeof record.token !== "string"
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
		|| typeof record.sessionId !== "string"
		|| (record.targetKind !== "async" && record.targetKind !== "foreground")
		|| typeof record.runId !== "string"
		|| typeof record.requestedId !== "string"
		|| typeof record.createdAt !== "number"
		|| typeof record.expiresAt !== "number") return undefined;
	return record as WaitSubscriptionRecord;
}

function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention" || run.steps.some((step) => step.activityState === "needs_attention");
}

function subscriptionFile(dir: string, token: string): string {
	return path.join(dir, `${token}.json`);
}

function subscriptionClaimFile(dir: string, token: string, claimedAt: number): string {
	return path.join(dir, `${token}.claim-${Math.floor(claimedAt)}-${randomUUID()}.json`);
}

interface WaitDeliveryReplay {
	version: 1;
	token: string;
	sessionId: string;
	deliveredAt: number;
	expiresAt: number;
}

function waitDeliveryReplayPath(resultsDir: string, token: string): string {
	return path.join(resultsDir, WAIT_DELIVERY_REPLAY_DIR, `${token}.json`);
}

function removeBestEffort(filePath: string): void {
	try { fs.rmSync(filePath, { force: true }); } catch { /* replay cleanup only */ }
}

function readWaitDeliveryReplay(resultsDir: string, record: WaitSubscriptionRecord, readAt: number): WaitDeliveryReplay | undefined {
	const replayPath = waitDeliveryReplayPath(resultsDir, record.token);
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(replayPath, "utf-8"));
	} catch (error) {
		if (isNotFound(error)) return undefined;
		console.error(`Failed to read wait delivery replay '${record.token}':`, error);
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		removeBestEffort(replayPath);
		return undefined;
	}
	const replay = value as Partial<WaitDeliveryReplay>;
	if (replay.version !== 1
		|| replay.token !== record.token
		|| replay.sessionId !== record.sessionId
		|| typeof replay.deliveredAt !== "number"
		|| typeof replay.expiresAt !== "number") {
		removeBestEffort(replayPath);
		return undefined;
	}
	if (replay.expiresAt <= readAt) {
		removeBestEffort(replayPath);
		return undefined;
	}
	return replay as WaitDeliveryReplay;
}

function writeWaitDeliveryReplay(resultsDir: string, record: WaitSubscriptionRecord, deliveredAt: number): void {
	writePrivateAtomicJson(waitDeliveryReplayPath(resultsDir, record.token), {
		version: 1,
		token: record.token,
		sessionId: record.sessionId,
		deliveredAt,
		// Keep the receipt past both subscription expiry and stale-claim recovery.
		expiresAt: Math.max(record.expiresAt, deliveredAt) + FOREIGN_SWEEP_GRACE_MS + CLAIM_LEASE_MS,
	} satisfies WaitDeliveryReplay);
}

function parseSubscriptionClaimName(file: string): { token: string; claimedAt: number } | undefined {
	const match = file.match(/^([0-9a-f-]{36})\.claim-(\d+)-[0-9a-f-]{36}\.json$/i);
	if (!match) return undefined;
	const claimedAt = Number(match[2]);
	return Number.isSafeInteger(claimedAt) ? { token: match[1]!, claimedAt } : undefined;
}

export function formatWaitSubscriptions(state: Pick<SubagentState, "waitSubscriptions">, now = Date.now()): string | undefined {
	const subscriptions = [...(state.waitSubscriptions?.values() ?? [])].sort((left, right) => left.createdAt - right.createdAt);
	if (subscriptions.length === 0) return undefined;
	const lines = [`Armed wait subscriptions (${subscriptions.length}):`];
	for (const record of subscriptions) {
		lines.push(`- ${record.token}: ${record.targetKind} run ${record.runId}, timeout in ${Math.max(0, record.expiresAt - now)}ms`);
	}
	return lines.join("\n");
}

export function createWaitSubscriptionManager(
	pi: Pick<ExtensionAPI, "events" | "sendMessage">,
	state: SubagentState,
	options: WaitSubscriptionManagerOptions = {},
): WaitSubscriptionManager {
	const asyncDirRoot = options.asyncDirRoot ?? DIRS.async;
	const resultsDir = options.resultsDir ?? DIRS.results;
	const subscriptionsDir = options.subscriptionsDir ?? path.join(path.dirname(asyncDirRoot), "wait-subscriptions");
	const now = options.now ?? Date.now;
	const subscriptions = state.waitSubscriptions ?? new Map<string, WaitSubscriptionRecord>();
	state.waitSubscriptions = subscriptions;
	const unresolvedRestoredForegroundTokens = new Set<string>();
	let disposed = false;
	let lastForeignSweepAt = 0;
	let lastClaimRecoveryAt = 0;

	const recoverStaleClaims = (force = false) => {
		const recoveredAt = now();
		if (!force && recoveredAt - lastClaimRecoveryAt < FOREIGN_SWEEP_INTERVAL_MS) return;
		lastClaimRecoveryAt = recoveredAt;
		let files: string[];
		try {
			files = fs.readdirSync(subscriptionsDir);
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to scan wait subscription claims in '${subscriptionsDir}':`, error);
			return;
		}
		for (const file of files) {
			const claim = parseSubscriptionClaimName(file);
			if (!claim || recoveredAt - claim.claimedAt <= CLAIM_LEASE_MS) continue;
			const claimPath = path.join(subscriptionsDir, file);
			const originalPath = subscriptionFile(subscriptionsDir, claim.token);
			try {
				// Linking recreates the canonical record without overwriting a retry
				// restored concurrently by the original claimant.
				fs.linkSync(claimPath, originalPath);
				fs.unlinkSync(claimPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST") {
					try { fs.unlinkSync(claimPath); } catch (unlinkError) { if (!isNotFound(unlinkError)) console.error(`Failed to remove superseded wait subscription claim '${claimPath}':`, unlinkError); }
				} else if (!isNotFound(error)) {
					console.error(`Failed to recover wait subscription claim '${claimPath}':`, error);
				}
			}
		}
	};

	/**
	 * Remove expired records armed by another session.
	 *
	 * Only the owning session can be woken, so restore() never loads a foreign
	 * record into `subscriptions` and reconcileRecord() returns before its
	 * timeout branch. Nothing reconciles such a record and nothing expires it, so
	 * a session that arms a wait and never comes back (forked, renamed, deleted)
	 * leaves one file here per wait, forever.
	 *
	 * Kept for FOREIGN_SWEEP_GRACE_MS past expiry so an owner that resumes late
	 * still finds its record and gets the timeout notice.
	 *
	 * Runs on the reconcile timer as well as at restore(), because a record that
	 * is still live when another session starts would otherwise never be looked
	 * at again: restore() only fires on session_start, and reconcile() walks the
	 * in-memory map, which holds current-session records only. A host that keeps
	 * one session open for hours is exactly where that gap bites.
	 *
	 * Never throws: it runs from the reconcile timer.
	 */
	const sweepExpiredForeignSubscriptions = (force = false) => {
		const sweptAt = now();
		if (!force && sweptAt - lastForeignSweepAt < FOREIGN_SWEEP_INTERVAL_MS) return;
		lastForeignSweepAt = sweptAt;
		let files: string[];
		try {
			files = fs.readdirSync(subscriptionsDir).filter((file) => file.endsWith(".json"));
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to scan wait subscriptions in '${subscriptionsDir}':`, error);
			return;
		}
		for (const file of files) {
			const filePath = path.join(subscriptionsDir, file);
			let record: WaitSubscriptionRecord | undefined;
			try {
				record = parseRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")));
			} catch (error) {
				console.error(`Ignoring invalid wait subscription '${filePath}':`, error);
				continue;
			}
			if (!record || file !== `${record.token}.json`) continue;
			// The owning session keeps its own expired records so reconcileRecord()
			// can still settle them with the "timed out" notice callers expect.
			if (record.sessionId === state.currentSessionId) continue;
			if (sweptAt < record.expiresAt + FOREIGN_SWEEP_GRACE_MS) continue;
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				// Losing this race is harmless: another session may have swept the
				// same expired record. Anything else is reported and retried on the
				// next sweep rather than interrupting the caller.
				if (!isNotFound(error)) console.error(`Failed to remove expired wait subscription '${filePath}':`, error);
			}
		}
	};

	const settle = (record: WaitSubscriptionRecord, outcome: string, detail: string, completion?: WaitCompletion) => {
		if (disposed || state.currentSessionId !== record.sessionId) return;
		const originalPath = subscriptionFile(subscriptionsDir, record.token);
		const claimPath = subscriptionClaimFile(subscriptionsDir, record.token, now());
		try {
			// Renaming is the cross-process lease: only its current claimant may
			// deliver now. Transport remains at-least-once: stale claims are retried,
			// while the durable session receipt makes repeat deliveries no-ops.
			// A crash after sendMessage succeeds but before that receipt is durable
			// can still duplicate one wake; that is deliberate rather than risking a
			// lost wake by recording delivery before the send.
			fs.renameSync(originalPath, claimPath);
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to claim wait subscription '${record.token}':`, error);
			else {
				let claimExists = false;
				try {
					claimExists = fs.readdirSync(subscriptionsDir).some((file) => parseSubscriptionClaimName(file)?.token === record.token);
				} catch (scanError) {
					if (!isNotFound(scanError)) console.error(`Failed to inspect wait subscription claims in '${subscriptionsDir}':`, scanError);
				}
				if (!claimExists) {
					subscriptions.delete(record.token);
					unresolvedRestoredForegroundTokens.delete(record.token);
				}
			}
			return;
		}
		const replayPath = waitDeliveryReplayPath(resultsDir, record.token);
		const finishSettlement = (alreadyDelivered: boolean) => {
			try {
				fs.unlinkSync(claimPath);
			} catch (error) {
				if (!isNotFound(error)) {
					const phase = alreadyDelivered ? "after recognizing its prior delivery" : "after delivering it";
					console.error(`Failed to clear wait subscription claim '${record.token}' ${phase}; it will be deduplicated after the claim lease:`, error);
					return;
				}
			}
			subscriptions.delete(record.token);
			unresolvedRestoredForegroundTokens.delete(record.token);
			removeBestEffort(replayPath);
		};
		if (readWaitDeliveryReplay(resultsDir, record, now())) {
			finishSettlement(true);
			return;
		}
		try {
			pi.sendMessage({
				customType: "subagent-wait-subscription",
				content: `Wait subscription ${record.token} fired for run ${record.runId}: ${outcome}. ${detail}`,
				display: true,
				details: {
					token: record.token,
					runId: record.runId,
					outcome,
					...(completion ? { completions: [completion] } : {}),
				},
			}, { triggerTurn: true });
		} catch (error) {
			try {
				fs.renameSync(claimPath, originalPath);
			} catch (restoreError) {
				console.error(`Failed to restore wait subscription '${record.token}' after delivery failed:`, restoreError);
			}
			console.error(`Failed to deliver wait subscription '${record.token}'; it remains armed:`, error);
			return;
		}
		try {
			writeWaitDeliveryReplay(resultsDir, record, now());
		} catch (error) {
			// Sending already succeeded. Continue claim cleanup; if that also fails,
			// stale-claim recovery may redeliver rather than risk losing the wake.
			console.error(`Failed to persist wait delivery replay '${record.token}':`, error);
		}
		finishSettlement(false);
	};

	const reconcileRecord = (record: WaitSubscriptionRecord) => {
		if (record.sessionId !== state.currentSessionId) return;
		if (now() >= record.expiresAt) {
			settle(record, "timed out", "The targeted run may still be active; inspect its status before taking follow-up action.");
			return;
		}
		if (record.targetKind === "foreground") {
			const run = state.foregroundRuns?.get(record.runId);
			if (!run && unresolvedRestoredForegroundTokens.has(record.token)) return;
			if (run) unresolvedRestoredForegroundTokens.delete(record.token);
			if (!run || run.sessionId !== record.sessionId) {
				settle(record, "could not be reconciled", "The remembered foreground run disappeared before completion was confirmed.");
				return;
			}
			const detached = run.children.filter((child) => child.status === "detached");
			if (detached.some((child) => child.activityState === "needs_attention" && child.currentTool === "contact_supervisor")) {
				settle(record, "needs attention", "Reply to the pending supervisor request or inspect the run status.");
				return;
			}
			if (detached.length === 0) {
				const failed = run.children.some((child) => child.status === "failed");
				settle(record, failed ? "failed" : "completed", "Inspect the run status for its final output.");
			}
			return;
		}

		const runs = listAsyncRuns(asyncDirRoot, {
			sessionId: record.sessionId,
			runId: record.runId,
			exactRunId: true,
			resultsDir,
			kill: options.kill,
			now,
		});
		const run = runs.find((candidate) => candidate.id === record.runId);
		if (!run) {
			settle(record, "could not be reconciled", "The exact async run disappeared before a terminal result was confirmed.");
			return;
		}
		if (needsAttention(run)) {
			settle(record, "needs attention", "Inspect the run status and answer any pending supervisor request.");
			return;
		}
		if (run.state !== "queued" && run.state !== "running") {
			let completion: WaitCompletion | undefined;
			try {
				completion = readCompletionReplay(resultsDir, record.runId, { sessionId: record.sessionId, now: now() })?.completion;
			} catch (error) {
				console.error(`Failed to read completion replay for wait subscription '${record.token}':`, error);
			}
			const detail = formatResumeFirstFailedRunDetail(run) ?? "Inspect the run status for its final output.";
			const archiveDetail = completion?.archivePath ? ` Completion archive: ${completion.archivePath}.` : "";
			settle(record, run.state === "complete" ? "completed" : run.state, `${detail}${archiveDetail}`, completion);
		}
	};

	const reconcile = () => {
		if (disposed) return;
		recoverStaleClaims();
		// Before the session check: with no current session every record is
		// foreign, and expired ones should still be cleaned up.
		sweepExpiredForeignSubscriptions();
		if (!state.currentSessionId) return;
		for (const record of [...subscriptions.values()]) {
			try {
				reconcileRecord(record);
			} catch (error) {
				console.error(`Failed to reconcile wait subscription '${record.token}':`, error);
				settle(record, "reconciliation failed", "The targeted run could not be reconciled. Inspect its status before taking follow-up action.");
			}
		}
	};

	const wakeChannels = [
		INTERCOM_DETACH_REQUEST_EVENT,
		SUBAGENT_ASYNC_COMPLETE_EVENT,
		SUBAGENT_FOREGROUND_COMPLETE_EVENT,
		SUBAGENT_CONTROL_EVENT,
		SUBAGENT_CONTROL_INTERCOM_EVENT,
		SUBAGENT_RESULT_INTERCOM_EVENT,
	];
	const unsubscribes = wakeChannels.map((channel) => pi.events.on(channel, reconcile));
	const interval = setInterval(reconcile, options.pollIntervalMs ?? RECONCILE_INTERVAL_MS);
	interval.unref?.();

	return {
		arm(input) {
			const sessionId = state.currentSessionId;
			if (!sessionId) throw new Error("A wait subscription requires an active session identity.");
			const createdAt = now();
			const record: WaitSubscriptionRecord = {
				version: SUBSCRIPTION_VERSION,
				token: randomUUID(),
				sessionId,
				targetKind: input.targetKind,
				runId: input.runId,
				requestedId: input.requestedId,
				createdAt,
				expiresAt: createdAt + input.timeoutMs,
			};
			fs.mkdirSync(subscriptionsDir, { recursive: true });
			writeAtomicJson(subscriptionFile(subscriptionsDir, record.token), record);
			subscriptions.set(record.token, record);
			return record;
		},
		restore() {
			subscriptions.clear();
			unresolvedRestoredForegroundTokens.clear();
			// Unconditional: a process that starts without a session identity should
			// still recover abandoned claims and clear records nobody can act on.
			recoverStaleClaims(true);
			sweepExpiredForeignSubscriptions(true);
			if (!state.currentSessionId) return;
			let files: string[];
			try {
				files = fs.readdirSync(subscriptionsDir).filter((file) => file.endsWith(".json"));
			} catch (error) {
				if (isNotFound(error)) return;
				throw error;
			}
			for (const file of files) {
				try {
					const record = parseRecord(JSON.parse(fs.readFileSync(path.join(subscriptionsDir, file), "utf-8")));
					if (!record || file !== `${record.token}.json`) continue;
					if (record.sessionId === state.currentSessionId) {
						subscriptions.set(record.token, record);
						if (record.targetKind === "foreground" && !state.foregroundRuns?.has(record.runId)) unresolvedRestoredForegroundTokens.add(record.token);
					}
				} catch (error) {
					console.error(`Ignoring invalid wait subscription '${path.join(subscriptionsDir, file)}':`, error);
				}
			}
			reconcile();
		},
		reconcile,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(interval);
			for (const unsubscribe of unsubscribes) {
				try { unsubscribe(); } catch { /* best effort */ }
			}
			subscriptions.clear();
		},
	};
}
