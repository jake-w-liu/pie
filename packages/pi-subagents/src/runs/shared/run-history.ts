import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";
import { isUnexplainedProcessSignal } from "./process-signal.ts";

export type RunOutcome = "completed" | "failed" | "timed_out" | "stopped" | "interrupted";

export interface RunEntry {
	agent: string;
	task: string;
	taskHash?: string;
	ts: number;
	status: "ok" | "error";
	outcome?: RunOutcome;
	duration: number;
	exit?: number;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REDACTED_TASK = "[redacted]";

type HistoryFileState = { mtimeMs: number; ctimeMs: number; size: number; ino: number; lineCount: number };

const historyFileStates = new Map<string, HistoryFileState>();

function isSameHistoryFileState(cached: HistoryFileState, stat: fs.Stats): boolean {
	return cached.mtimeMs === stat.mtimeMs
		&& cached.ctimeMs === stat.ctimeMs
		&& cached.size === stat.size
		&& cached.ino === stat.ino;
}

function getHistoryPath(): string {
	return path.join(getAgentDir(), "run-history.jsonl");
}

function hashTask(task: string): string {
	return createHash("sha256").update(task).digest("hex");
}

function hardenHistoryStorage(historyPath: string): void {
	const historyDir = path.dirname(historyPath);
	fs.mkdirSync(historyDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	try {
		if ((fs.statSync(historyDir).mode & 0o777) !== PRIVATE_DIR_MODE) fs.chmodSync(historyDir, PRIVATE_DIR_MODE);
	} catch {}
	try {
		if ((fs.statSync(historyPath).mode & 0o777) !== PRIVATE_FILE_MODE) fs.chmodSync(historyPath, PRIVATE_FILE_MODE);
	} catch {}
}

function sanitizeHistoryLine(line: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;

	const record = value as Record<string, unknown>;
	const task = typeof record.task === "string" ? record.task : "";
	const taskHash = typeof record.taskHash === "string" && record.taskHash
		? record.taskHash
		: task && task !== REDACTED_TASK
			? hashTask(task)
			: undefined;

	return JSON.stringify({
		...record,
		task: REDACTED_TASK,
		...(taskHash ? { taskHash } : {}),
	});
}

function sanitizeHistoryLines(raw: string): { lines: string[]; changed: boolean } {
	const lines: string[] = [];
	let changed = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const sanitized = sanitizeHistoryLine(trimmed);
		if (!sanitized) {
			changed = true;
			continue;
		}
		if (sanitized !== trimmed) changed = true;
		lines.push(sanitized);
	}
	return { lines, changed };
}

/**
 * Replace the whole history file atomically.
 *
 * `writeFileSync` opens with `O_TRUNC`, so a crash between the truncate and the
 * write leaves a truncated (or 0-byte) history file. Write to a temp file in the
 * same directory and `rename(2)` it over the target instead: a reader then sees
 * either the previous file or the new one, never a partial one.
 */
function writePrivateHistory(historyPath: string, lines: string[]): void {
	const tempPath = path.join(path.dirname(historyPath), `.${path.basename(historyPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempPath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
		// `mode` is masked by the process umask, so re-assert it on the temp file
		// before it becomes the live history file.
		try { fs.chmodSync(tempPath, PRIVATE_FILE_MODE); } catch {}
		fs.renameSync(tempPath, historyPath);
	} catch (error) {
		try { fs.rmSync(tempPath, { force: true }); } catch {}
		throw error;
	}
	try { fs.chmodSync(historyPath, PRIVATE_FILE_MODE); } catch {}
}

function rememberHistoryFile(historyPath: string, lineCount: number): void {
	const stat = fs.statSync(historyPath);
	historyFileStates.set(historyPath, {
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: stat.size,
		ino: stat.ino,
		lineCount,
	});
	if (historyFileStates.size > 8) historyFileStates.delete(historyFileStates.keys().next().value!);
}

function rotateHistoryLines(lines: string[]): { lines: string[]; changed: boolean } {
	if (lines.length <= ROTATE_READ_THRESHOLD) return { lines, changed: false };
	return { lines: lines.slice(-ROTATE_KEEP), changed: true };
}

function sanitizeHistoryFile(historyPath: string): number {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(historyPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	const cached = historyFileStates.get(historyPath);
	// A single-writer process hits this cache on every recordRun, so the
	// rotation bound has to be enforced here too: checking it only on a cache
	// miss would let the file grow without limit.
	if (cached && isSameHistoryFileState(cached, stat) && cached.lineCount <= ROTATE_READ_THRESHOLD) {
		return cached.lineCount;
	}
	const raw = fs.readFileSync(historyPath, "utf-8");
	const sanitized = sanitizeHistoryLines(raw);
	const rotated = rotateHistoryLines(sanitized.lines);
	if (rotated.changed || sanitized.changed) writePrivateHistory(historyPath, rotated.lines);
	rememberHistoryFile(historyPath, rotated.lines.length);
	return rotated.lines.length;
}

function appendPrivateHistoryLine(historyPath: string, line: string): void {
	const fd = fs.openSync(historyPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, PRIVATE_FILE_MODE);
	try {
		fs.writeSync(fd, `${line}\n`);
	} finally {
		fs.closeSync(fd);
	}
}

export function recordRun(
	agent: string,
	task: string,
	exitCode: number,
	durationMs: number,
	terminal: { interrupted?: boolean; processSignal?: string | null; stopped?: boolean; timedOut?: boolean; turnBudgetExceeded?: boolean } = {},
): void {
	try {
		const outcome: RunOutcome = terminal.stopped
			? "stopped"
			: terminal.interrupted
				? "interrupted"
				: terminal.timedOut
					? "timed_out"
					: exitCode !== 0 && isUnexplainedProcessSignal(terminal)
						? "stopped"
						: exitCode === 0 ? "completed" : "failed";
		const entry: RunEntry = {
			agent,
			task: REDACTED_TASK,
			taskHash: hashTask(task),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			outcome,
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		const historyPath = getHistoryPath();
		hardenHistoryStorage(historyPath);
		let lineCount: number | undefined;
		try { lineCount = sanitizeHistoryFile(historyPath); } catch {}
		appendPrivateHistoryLine(historyPath, JSON.stringify(entry));
		if (lineCount === undefined) historyFileStates.delete(historyPath);
		else rememberHistoryFile(historyPath, lineCount + 1);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

export function loadRunsForAgent(agent: string): RunEntry[] {
	const historyPath = getHistoryPath();
	try { hardenHistoryStorage(historyPath); } catch {}
	if (!fs.existsSync(historyPath)) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(historyPath, "utf-8");
	} catch {
		return [];
	}

	// Read-only: a reader must never rewrite the file. Rewriting here would
	// replace the whole file from a snapshot that another process may have
	// appended to in the meantime, silently dropping those appends. Sanitizing
	// and rotating are the writer's job (see `sanitizeHistoryFile`), which runs
	// on every `recordRun` before the append.
	const { lines } = sanitizeHistoryLines(raw);
	try {
		rememberHistoryFile(historyPath, lines.length);
	} catch {}

	return lines
		.map((line) => { try { return JSON.parse(line) as RunEntry; } catch { return undefined; } })
		.filter((entry): entry is RunEntry => entry !== undefined && entry.agent === agent)
		.reverse();
}
