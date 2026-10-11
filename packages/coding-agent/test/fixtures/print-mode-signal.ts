import { runPrintMode } from "../../src/modes/print-mode.ts";

const signal = process.env.TEST_SIGNAL as NodeJS.Signals;
if (!signal) throw new Error("TEST_SIGNAL required");
const disposeRejects = process.env.TEST_DISPOSE_REJECTS === "1";
const signalDuringDispose = process.env.TEST_SIGNAL_DURING_DISPOSE === "1";
const realExit = process.env.TEST_REAL_EXIT === "1";

const originalWrite = process.stdout.write;
const originalExit = process.exit;
let writeCompleted = false;
let exitBeforeWriteCompleted = false;
let exitBeforeDisposeSettled = false;
let exitCode: number | undefined;
let listener: ((event: object) => void) | undefined;
let disposeAttempted = false;
let disposeSettled = false;
let unhandledRejections = 0;
process.on("unhandledRejection", () => {
	unhandledRejections++;
});

process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
	const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	// Delay the real write so a flush that returns before it completes is detectable,
	// then forward the bytes: the real-exit path asserts their presence on stdout.
	setTimeout(() => {
		writeCompleted = true;
		if (typeof done === "function")
			originalWrite.call(process.stdout, chunk as string, undefined, done as () => void);
		else originalWrite.call(process.stdout, chunk as string);
	}, 100);
	return false;
}) as typeof process.stdout.write;
if (!realExit) {
	// With TEST_REAL_EXIT the process must actually terminate, so the parent can assert
	// the real OS exit status instead of the argument handed to a stub.
	process.exit = ((code?: number) => {
		exitCode = code;
		exitBeforeWriteCompleted = !writeCompleted;
		exitBeforeDisposeSettled = !disposeSettled;
	}) as typeof process.exit;
}

const session = {
	sessionManager: { getHeader: () => undefined },
	agent: { subscribe: () => () => {} },
	state: { messages: [] },
	bindExtensions: async () => {},
	subscribe: (callback: (event: object) => void) => {
		listener = callback;
		return () => {};
	},
	prompt: async () => {
		listener?.({ type: "context_limit", tokens: 1, contextWindow: 1 });
		if (!signalDuringDispose) {
			process.emit(signal);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	},
	reload: async () => {},
};
const runtime = {
	session,
	setRebindSession: () => {},
	newSession: async () => ({}),
	fork: async () => ({}),
	switchSession: async () => ({}),
	dispose: async () => {
		disposeAttempted = true;
		try {
			if (signalDuringDispose) {
				process.kill(process.pid, signal);
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			if (disposeRejects) throw new Error("dispose failed");
		} finally {
			disposeSettled = true;
		}
	},
};

await runPrintMode(runtime as never, { mode: "json", initialMessage: "test" });
await new Promise((resolve) => setTimeout(resolve, 150));
process.stdout.write = originalWrite;
process.exit = originalExit;
originalWrite.call(
	process.stdout,
	`${JSON.stringify({ disposeAttempted, disposeSettled, exitCode, exitBeforeDisposeSettled, exitBeforeWriteCompleted, unhandledRejections, writeCompleted })}\n`,
);
