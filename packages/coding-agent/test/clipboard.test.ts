import { EventEmitter } from "node:events";
import { execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			getText: vi.fn<() => Promise<string>>(),
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		execFileSync: vi.fn(),
		execSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		execFileSync: mocks.execFileSync,
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.getText.mockReset();
	mocks.clipboard.setText.mockReset();
	mocks.execFileSync.mockReset();
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.getText.mockResolvedValue("");
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

interface FakeStdio extends EventEmitter {
	write(chunk: string): boolean;
	end(): void;
}

interface FakeProcess extends EventEmitter {
	stdin: FakeStdio;
	stdout: EventEmitter;
	kill(): boolean;
}

function makeFakeProcess(): FakeProcess {
	const proc = new EventEmitter() as FakeProcess;
	const stdin = new EventEmitter() as FakeStdio;
	stdin.write = () => true;
	stdin.end = () => {};
	proc.stdin = stdin;
	proc.stdout = new EventEmitter();
	proc.kill = () => true;
	return proc;
}

function installSpawnStub(behavior: (proc: FakeProcess) => void): void {
	mockedSpawn.mockImplementation((() => {
		const proc = makeFakeProcess();
		behavior(proc);
		return proc;
	}) as unknown as typeof spawn);
}

/** Tool exits 0 as soon as stdin closes, like a healthy pbcopy. */
function stubSpawnWriteSuccess(): void {
	installSpawnStub((proc) => {
		proc.stdin.end = () => {
			queueMicrotask(() => proc.emit("close", 0, null));
		};
	});
}

/** Tool exits nonzero, like a failing pbcopy. */
function stubSpawnFailing(): void {
	installSpawnStub((proc) => {
		proc.stdin.end = () => {
			queueMicrotask(() => proc.emit("close", 1, null));
		};
	});
}

/** Tool binary is missing (spawn ENOENT), like wl-paste without Wayland tools. */
function stubSpawnMissing(): void {
	installSpawnStub((proc) => {
		queueMicrotask(() => proc.emit("error", new Error("spawn ENOENT")));
	});
}

/** wl-paste prints text then exits 0. */
function stubSpawnReadSuccess(text: string): void {
	installSpawnStub((proc) => {
		queueMicrotask(() => {
			if (text.length > 0) proc.stdout.emit("data", Buffer.from(text));
			proc.emit("close", 0, null);
		});
	});
}

/** Tool never exits and never errors, like a wedged clipboard daemon. */
function stubSpawnHanging(): void {
	installSpawnStub(() => {});
}

/** Max event-loop stall in ms while awaiting `work`. */
async function measureEventLoopLag(work: Promise<unknown>): Promise<number> {
	let maxLag = 0;
	let last = Date.now();
	const watchdog = setInterval(() => {
		const now = Date.now();
		maxLag = Math.max(maxLag, now - last - 5);
		last = now;
	}, 5);
	try {
		await work;
	} finally {
		clearInterval(watchdog);
	}
	return maxLag;
}

describe("readClipboardText", () => {
	test("returns native clipboard text", async () => {
		mocks.clipboard.getText.mockResolvedValue("clipboard text");

		await expect(readClipboardText()).resolves.toBe("clipboard text");
	});

	test("reads the Wayland clipboard before the stale native X11 clipboard", async () => {
		// Regression test for #7248.
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		stubSpawnReadSuccess("Wayland text");
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBe("Wayland text");
		expect(mockedSpawn).toHaveBeenCalledWith(
			"wl-paste",
			["--no-newline", "--type", "text"],
			expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
		);
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("does not fall back to stale X11 text when the Wayland clipboard is empty", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		stubSpawnReadSuccess("");
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("falls back to the native clipboard when wl-paste is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		stubSpawnMissing();
		mocks.clipboard.getText.mockResolvedValue("X11 fallback text");

		await expect(readClipboardText()).resolves.toBe("X11 fallback text");
	});

	test("returns null for empty or unavailable clipboard text", async () => {
		await expect(readClipboardText()).resolves.toBeNull();

		mocks.clipboard.getText.mockRejectedValue(new Error("clipboard unavailable"));
		await expect(readClipboardText()).resolves.toBeNull();
	});

	test("never blocks the event loop on synchronous child_process calls", async () => {
		// The read path must stay async: a hung wl-paste used to freeze the
		// whole TUI via execFileSync.
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		stubSpawnHanging();
		mocks.clipboard.getText.mockResolvedValue("fallback");

		const pending = readClipboardText();
		const lag = await measureEventLoopLag(pending);
		await expect(pending).resolves.toBe("fallback");
		expect(lag).toBeLessThan(1000);
		expect(mockedExecFileSync).not.toHaveBeenCalled();
	}, 15_000);
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and shell fallbacks", async () => {
		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(osc52Writes()).toHaveLength(0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(1);
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		stubSpawnWriteSuccess();

		await copyToClipboard("hello");

		expect(mockedSpawn).toHaveBeenCalledWith(
			"pbcopy",
			[],
			expect.objectContaining({ stdio: ["pipe", "ignore", "ignore"] }),
		);
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		stubSpawnFailing();

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		stubSpawnFailing();

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("never blocks the event loop while a clipboard tool hangs", async () => {
		// Regression test: pbcopy/xclip used to run via execSync, freezing the
		// whole TUI until the tool exited or its timeout fired.
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		stubSpawnHanging();

		const lag = await measureEventLoopLag(copyToClipboard("hello").catch(() => undefined));
		// The hung tool must not stall input/rendering; the kill timeout
		// rejects in the background instead.
		expect(lag).toBeLessThan(1000);
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(mockedExecFileSync).not.toHaveBeenCalled();
	}, 15_000);
});
