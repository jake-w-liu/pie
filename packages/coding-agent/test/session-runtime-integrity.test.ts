import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionRuntimeFixture } from "./session-runtime-fixture.ts";

const dirs: string[] = [];
const fixtures: Awaited<ReturnType<typeof createSessionRuntimeFixture>>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(persisted = true, cancel = false) {
	const dir = mkdtempSync(join(tmpdir(), "pi-runtime-integrity-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	const incoming = join(dir, "incoming");
	mkdirSync(incoming);
	const sessionManager = persisted ? SessionManager.create(dir, sessions) : SessionManager.inMemory(dir);
	sessionManager.appendMessage({ role: "user", content: "outgoing", timestamp: 1 });
	sessionManager.appendMessage(fauxAssistantMessage("original"));
	const result = await createSessionRuntimeFixture({
		cwd: dir,
		sessionManager,
		extensions: [
			(pi) => {
				pi.on("session_before_switch", () => ({ cancel }));
				pi.on("session_before_fork", () => ({ cancel }));
			},
		],
	});
	fixtures.push(result);
	return { ...result, dir, sessions, incoming, sessionManager };
}

it.each([false, true])("import preserves existing same-basename bytes (invalid=%s)", async (invalid) => {
	const f = await fixture();
	const outgoing = f.runtime.session;
	const originalPath = outgoing.sessionFile!;
	const original = readFileSync(originalPath, "utf8");
	const sourcePath = join(f.incoming, basename(originalPath));
	const source = invalid ? "invalid session" : original.replace("original", "imported");
	writeFileSync(sourcePath, source);
	if (invalid) {
		await expect(f.runtime.importFromJsonl(sourcePath)).rejects.toThrow();
		expect(f.runtime.session).toBe(outgoing);
		expect(readdirSync(f.sessions)).toEqual([basename(originalPath)]);
		f.harness.setResponses([fauxAssistantMessage("still usable")]);
		await f.runtime.session.prompt("continue after failed import");
	} else {
		await expect(f.runtime.importFromJsonl(sourcePath)).resolves.toEqual({ cancelled: false });
		expect(f.runtime.session.sessionFile).not.toBe(originalPath);
		expect(readFileSync(originalPath, "utf8")).toBe(original);
		expect(JSON.stringify(f.runtime.session.messages)).toContain("imported");
	}
	expect(readFileSync(sourcePath, "utf8")).toBe(source);
	// A valid continuation after failure may append, but must not erase the original history.
	expect(readFileSync(originalPath, "utf8")).toContain(original.trim());
});

it("failed cwd validation and cancellation leave storage and the active session intact", async () => {
	const f = await fixture();
	const outgoing = f.runtime.session;
	const before = readdirSync(f.sessions);
	const sourcePath = join(f.incoming, "missing-cwd.jsonl");
	const source = JSON.stringify({
		type: "session",
		version: 3,
		id: "missing-cwd",
		cwd: join(f.dir, "missing"),
		timestamp: new Date().toISOString(),
	});
	writeFileSync(sourcePath, source);
	await expect(f.runtime.importFromJsonl(sourcePath)).rejects.toThrow("working directory does not exist");
	expect(f.runtime.session).toBe(outgoing);
	expect(readdirSync(f.sessions)).toEqual(before);
	expect(readFileSync(sourcePath, "utf8")).toBe(source);
	await expect(f.runtime.importFromJsonl(sourcePath, f.dir)).resolves.toEqual({ cancelled: false });
	expect(f.runtime.cwd).toBe(f.dir);

	const cancelled = await fixture(true, true);
	const cancelledSource = join(cancelled.incoming, "cancelled.jsonl");
	writeFileSync(cancelledSource, readFileSync(cancelled.runtime.session.sessionFile!));
	const oldSession = cancelled.runtime.session;
	const oldFiles = readdirSync(cancelled.sessions);
	await expect(cancelled.runtime.importFromJsonl(cancelledSource)).resolves.toEqual({ cancelled: true });
	expect(cancelled.runtime.session).toBe(oldSession);
	expect(readdirSync(cancelled.sessions)).toEqual(oldFiles);
});

it.each(["legacy.jsonl", `${"l".repeat(240)}.jsonl`])(
	"imports legacy snapshots without migrating the source and reuses managed paths (%s)",
	async (name) => {
		const f = await fixture();
		const sourcePath = join(f.incoming, name);
		const source = JSON.stringify({ type: "session", id: "legacy", cwd: f.dir, timestamp: new Date().toISOString() });
		writeFileSync(sourcePath, source);
		await f.runtime.importFromJsonl(sourcePath);
		expect(readFileSync(sourcePath, "utf8")).toBe(source);
		const managed = f.runtime.session.sessionFile!;
		const files = readdirSync(f.sessions);
		await f.runtime.importFromJsonl(managed);
		expect(f.runtime.session.sessionFile).toBe(managed);
		expect(readdirSync(f.sessions)).toEqual(files);
	},
);

it.each(["before", "at"] as const)(
	"settles an active in-memory fork %s without shutdown or late-response contamination",
	async (position) => {
		let shutdownId: string | undefined;
		let shutdownHistory: string | undefined;
		const f = await createSessionRuntimeFixture({
			extensions: [
				(pi) => {
					pi.on("session_shutdown", (event, ctx) => {
						if (event.reason !== "fork") return;
						shutdownId = ctx.sessionManager.getSessionId();
						shutdownHistory = JSON.stringify(ctx.sessionManager.getEntries());
						pi.appendEntry("shutdown-only", { marker: true });
					});
				},
			],
		});
		fixtures.push(f);
		await f.runtime.session.bindExtensions({ mode: "rpc" });
		const manager = f.runtime.session.sessionManager;
		manager.newSession(); // Ensure "before" exercises the null-root fork branch.
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("first answer"));
		f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
		const oldId = manager.getSessionId();
		let started = false;
		f.harness.setResponses([
			async (_context, options) => {
				started = true;
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("late aborted response", { stopReason: "aborted" });
			},
		]);
		const pending = f.runtime.session.prompt("outgoing active turn");
		await expect.poll(() => started).toBe(true);
		await f.runtime.fork(firstId, { position });
		await pending;
		expect(shutdownId).toBe(oldId);
		expect(shutdownHistory).toContain("outgoing active turn");
		expect(manager.getSessionId()).not.toBe(oldId);
		const fork = JSON.stringify(f.runtime.session.sessionManager.getEntries());
		expect(fork).not.toContain("shutdown-only");
		expect(fork).not.toContain("outgoing active turn");
		expect(fork).not.toContain("late aborted response");
		expect(f.runtime.session.messages.filter((m) => m.role === "user")).toHaveLength(position === "before" ? 0 : 1);
	},
);

it("settles an active tool into the outgoing history before an in-memory fork", async () => {
	let started = false;
	let toolSettled = false;
	let shutdownId: string | undefined;
	let shutdownHistory = "";
	const f = await createSessionRuntimeFixture({
		customTools: [
			{
				name: "waiting_tool",
				label: "Waiting tool",
				description: "wait for cancellation",
				parameters: Type.Object({}),
				async execute(_id, _args, signal) {
					started = true;
					await new Promise<void>((resolve) => {
						if (signal?.aborted) resolve();
						else signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					toolSettled = true;
					return { content: [{ type: "text", text: "late-tool-result" }], details: {} };
				},
			},
		],
		extensions: [
			(pi) => {
				pi.on("session_shutdown", (event, ctx) => {
					if (event.reason !== "fork") return;
					shutdownId = ctx.sessionManager.getSessionId();
					shutdownHistory = JSON.stringify(ctx.sessionManager.getEntries());
				});
			},
		],
	});
	fixtures.push(f);
	const manager = f.runtime.session.sessionManager;
	const target = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
	f.runtime.session.agent.state.messages = manager.buildSessionContext().messages;
	const oldId = manager.getSessionId();
	f.harness.setResponses([fauxAssistantMessage(fauxToolCall("waiting_tool", {}))]);
	const pending = f.runtime.session.prompt("run outgoing tool");
	await expect.poll(() => started).toBe(true);
	await f.runtime.fork(target, { position: "at" });
	await pending;
	expect(toolSettled).toBe(true);
	expect(shutdownId).toBe(oldId);
	expect(shutdownHistory).toContain('"role":"toolResult"');
	expect(JSON.stringify(manager.getEntries())).not.toContain("waiting_tool");
	expect(JSON.stringify(manager.getEntries())).not.toContain("late-tool-result");
});

it("exclusive import creation cannot overwrite a destination created during the switch hook", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-import-race-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const source = join(dir, "source.jsonl");
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", version: 3, id: "source", cwd: dir, timestamp: new Date().toISOString() })}\n`,
	);
	let racedPath = "";
	const f = await createSessionRuntimeFixture({
		cwd: dir,
		sessionManager: manager,
		extensions: [
			(pi) => {
				pi.on("session_before_switch", (event) => {
					racedPath = event.targetSessionFile!;
					writeFileSync(racedPath, "competing session bytes");
				});
			},
		],
	});
	fixtures.push(f);
	const outgoing = f.runtime.session;
	await expect(f.runtime.importFromJsonl(source)).rejects.toMatchObject({ code: "EEXIST" });
	expect(readFileSync(racedPath, "utf8")).toBe("competing session bytes");
	expect(f.runtime.session).toBe(outgoing);
});

it("rejects a source emptied during import preflight without replacing the active runtime", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-import-source-race-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	const manager = SessionManager.create(dir, sessions);
	const source = join(dir, "source.jsonl");
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", version: 3, id: "source", cwd: dir, timestamp: new Date().toISOString() })}\n`,
	);
	const f = await createSessionRuntimeFixture({
		cwd: dir,
		sessionManager: manager,
		extensions: [
			(pi) => {
				pi.on("session_before_switch", () => {
					writeFileSync(source, "");
				});
			},
		],
	});
	fixtures.push(f);
	const outgoing = f.runtime.session;
	await expect(f.runtime.importFromJsonl(source)).rejects.toThrow("empty or invalid");
	expect(f.runtime.session).toBe(outgoing);
	expect(readdirSync(sessions)).toEqual([]);
});

it("cancelled forks do not tear down or mutate in-memory state", async () => {
	const f = await fixture(false, true);
	await f.runtime.session.bindExtensions({ mode: "rpc" });
	const old = f.runtime.session;
	const entries = structuredClone(f.sessionManager.getEntries());
	const result = await f.runtime.fork(entries[0].id);
	expect(result).toEqual({ cancelled: true });
	expect(f.runtime.session).toBe(old);
	expect(f.sessionManager.getEntries()).toEqual(entries);
});
