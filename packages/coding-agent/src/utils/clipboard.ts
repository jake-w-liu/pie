import { spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

/** Per-tool timeout: clipboard helpers must never wedge the TUI event loop. */
const CLIPBOARD_TOOL_TIMEOUT_MS = 5000;
const CLIPBOARD_MAX_READ_BYTES = 50 * 1024 * 1024;

/**
 * Run a clipboard tool with stdin input, asynchronously. execSync variants of
 * these calls block the event loop for the whole child lifetime (a hung
 * pbcopy/xclip visibly freezes the terminal on every select), so every tool
 * here goes through spawn with a kill timeout instead.
 */
function runClipboardWriter(command: string, args: readonly string[], text: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const done = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, [...args], { stdio: ["pipe", "ignore", "ignore"] });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already exited; the close handler below settles the promise.
			}
			done(new Error(`${command} timed out`));
		}, CLIPBOARD_TOOL_TIMEOUT_MS);
		proc.on("error", (error) => done(error));
		proc.on("close", (code) => {
			if (code === 0) done();
			else done(new Error(`${command} exited with code ${code ?? "unknown"}`));
		});
		const stdin = proc.stdin;
		if (!stdin) {
			done(new Error(`${command} has no stdin pipe`));
			return;
		}
		stdin.on("error", () => {
			// EPIPE when the tool exits early; the close handler reports it.
		});
		stdin.write(text);
		stdin.end();
	});
}

async function copyToX11Clipboard(text: string): Promise<void> {
	try {
		await runClipboardWriter("xclip", ["-selection", "clipboard"], text);
	} catch {
		await runClipboardWriter("xsel", ["--clipboard", "--input"], text);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

type ClipboardReadResult = { ok: true; text: string | null } | { ok: false };

async function readWaylandClipboardText(): Promise<ClipboardReadResult> {
	return new Promise<ClipboardReadResult>((resolve) => {
		let settled = false;
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("wl-paste", ["--no-newline", "--type", "text"], {
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			resolve({ ok: false });
			return;
		}
		const chunks: Buffer[] = [];
		let bytes = 0;
		let overflowed = false;
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already exited; close handler below settles the promise.
			}
			finish({ ok: false });
		}, CLIPBOARD_TOOL_TIMEOUT_MS);
		const finish = (result: ClipboardReadResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		proc.on("error", () => finish({ ok: false }));
		const stdout = proc.stdout;
		if (!stdout) {
			finish({ ok: false });
			return;
		}
		stdout.on("data", (chunk: Buffer) => {
			if (overflowed) return;
			bytes += chunk.length;
			if (bytes > CLIPBOARD_MAX_READ_BYTES) {
				overflowed = true;
				try {
					proc.kill("SIGKILL");
				} catch {
					// Close handler settles below.
				}
				finish({ ok: false });
				return;
			}
			chunks.push(chunk);
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				finish({ ok: false });
				return;
			}
			const text = Buffer.concat(chunks).toString("utf8");
			finish({ ok: true, text: text || null });
		});
	});
}

/** Read plain text from the system clipboard. */
export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux" && isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		const result = await readWaylandClipboardText();
		if (result.ok) {
			return result.text;
		}
	}

	if (!clipboard) {
		return null;
	}

	try {
		const text = await clipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	if (!copied) {
		try {
			if (p === "darwin") {
				await runClipboardWriter("pbcopy", [], text);
				copied = true;
			} else if (p === "win32") {
				await runClipboardWriter("clip", [], text);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						await runClipboardWriter("termux-clipboard-set", [], text);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// A missing wl-copy rejects (spawn ENOENT) and falls
							// through to the xclip/OSC 52 fallbacks below. Only a
							// clean exit claims success, so a failed wl-copy keeps
							// the fallbacks alive.
							await runClipboardWriter("wl-copy", [], text);
							copied = true;
						} catch {
							if (hasX11Display) {
								await copyToX11Clipboard(text);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						await copyToX11Clipboard(text);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
