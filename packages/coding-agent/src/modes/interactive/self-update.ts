import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

/** Keeps the end of the update log for error reports without unbounded growth. */
const MAX_OUTPUT_CHARS = 64 * 1024;

export type PieSourceCheckout = { ok: true; repository: string; updateScript: string } | { ok: false; error: string };

export interface PieUpdateResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** The last MAX_OUTPUT_CHARS characters of combined stdout and stderr. */
	output: string;
}

const BOOTSTRAP_HINT =
	"Install Pie from a git checkout once with `npm ci --ignore-scripts && npm run refresh:pie -- --no-bump`; later updates can then use /update.";

/**
 * Find the checkout the active Pie installation was built from. scripts/refresh-pie.sh
 * records it in source.json inside each release, and ~/.local/share/pie links to the
 * active release.
 */
export function resolvePieSourceCheckout(homeDir: string = homedir()): PieSourceCheckout {
	const metadataPath = join(homeDir, ".local", "share", "pie", "source.json");
	let metadata: unknown;
	try {
		metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { ok: false, error: `This Pie installation does not record its source checkout. ${BOOTSTRAP_HINT}` };
		}
		return {
			ok: false,
			error: `Could not read ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const repository =
		metadata && typeof metadata === "object" && "repository" in metadata ? metadata.repository : undefined;
	if (typeof repository !== "string" || repository.length === 0) {
		return { ok: false, error: `${metadataPath} does not name a source checkout. ${BOOTSTRAP_HINT}` };
	}
	const updateScript = join(repository, "scripts", "update-pie.sh");
	if (!existsSync(updateScript)) {
		return {
			ok: false,
			error: `The Pie checkout ${repository} is missing or predates /update (no scripts/update-pie.sh). Update it with \`git pull\`, then run \`npm run refresh:pie -- --no-bump\` there once.`,
		};
	}
	return { ok: true, repository, updateScript };
}

/**
 * Run scripts/update-pie.sh from the checkout. The script runs in its own process group,
 * so aborting stops the whole fetch, install, and build instead of only the shell.
 */
export function runPieUpdate(
	checkout: { repository: string; updateScript: string },
	options: { signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
): Promise<PieUpdateResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			resolve({ code: null, signal: "SIGTERM", output: "" });
			return;
		}
		const child = spawn("bash", [checkout.updateScript], {
			cwd: checkout.repository,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			// The TUI owns the terminal; fail instead of prompting for git credentials.
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		let output = "";
		const append = (chunk: string) => {
			output = (output + chunk).slice(-MAX_OUTPUT_CHARS);
			options.onOutput?.(chunk);
		};
		// Decode as UTF-8 streams so a character split across two chunks is not garbled.
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const abort = () => {
			// The PID belongs to the process group this call started.
			if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					// The group already exited.
				}
			}
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			options.signal?.removeEventListener("abort", abort);
			reject(error);
		});
		child.on("close", (code, signal) => {
			options.signal?.removeEventListener("abort", abort);
			resolve({ code, signal, output });
		});
	});
}

/**
 * The last non-empty lines of update output, for progress and error reports. Terminal control
 * sequences are removed because the lines are rendered inside the TUI, and a bare carriage return
 * (progress output rewriting its line) counts as a line break.
 */
export function lastOutputLines(output: string, count: number): string[] {
	return sanitizeBinaryOutput(stripAnsi(output))
		.split(/\r\n|\r|\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.slice(-count);
}

/** One-line result of a successful update. */
export function summarizePieUpdate(output: string): string {
	const lines = lastOutputLines(output, 50);
	const upToDate = lines.findLast((line) => line.startsWith("Pie is already up to date"));
	if (upToDate) return upToDate;
	const installed = lines.findLast((line) => line.startsWith("Installed Pie "));
	return installed
		? `${installed}. Restart Pie sessions to use it.`
		: "Pie was updated. Restart Pie sessions to use it.";
}
