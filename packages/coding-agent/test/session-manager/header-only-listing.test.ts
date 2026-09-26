import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { getDefaultSessionDirPath, type SessionHeaderInfo, SessionManager } from "../../src/core/session-manager.ts";

const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

let tempDir: string;
let previousAgentDir: string | undefined;

function writeSession(dir: string, name: string, id: string, cwd: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd })}\n` +
			`${JSON.stringify({
				type: "message",
				id: `${id}-1`,
				parentId: null,
				timestamp: "2025-01-01T00:00:01.000Z",
				message: { role: "user", content: `body of ${id}`, timestamp: 1735689600000 },
			})}\n`,
		"utf8",
	);
	return file;
}

/** (path, id, cwd) triples in a stable order so the two listings can be compared. */
function identity(sessions: Array<SessionHeaderInfo | { path: string; id: string; cwd: string }>): string[] {
	return sessions.map((session) => `${session.path}|${session.id}|${session.cwd}`).sort();
}

beforeEach(() => {
	previousAgentDir = process.env[ENV_AGENT_DIR];
	tempDir = mkdtempSync(join(tmpdir(), "pi-header-listing-"));
	process.env[ENV_AGENT_DIR] = tempDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("SessionManager header-only listing", () => {
	it("returns the same sessions as list() without building message text", async () => {
		const dir = join(tempDir, "custom");
		const local = writeSession(dir, "a.jsonl", "aaa", "/projects/a");
		const other = writeSession(dir, "b.jsonl", "bbb", "/projects/b");

		// Default listing for a custom dir keeps only the cwd's sessions.
		expect(identity(await SessionManager.listHeaders("/projects/a", dir))).toEqual(
			identity(await SessionManager.list("/projects/a", dir)),
		);
		expect(identity(await SessionManager.listHeaders("/projects/a", dir))).toEqual([`${local}|aaa|/projects/a`]);

		// Unfiltered listing (the global pass) must see both projects.
		expect(identity(await SessionManager.listAllHeaders(dir))).toEqual([
			`${local}|aaa|/projects/a`,
			`${other}|bbb|/projects/b`,
		]);
	});

	it("stops at the header scan limit instead of streaming the whole file", async () => {
		const dir = join(tempDir, "oversized");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "late-header.jsonl");
		writeFileSync(file, "", "utf8");
		// Unparseable padding: both readers skip it, so only the header itself decides.
		const pad = `${"{not-json".padEnd(511, ".")}\n`;
		for (let written = 0; written < HEADER_SCAN_LIMIT_BYTES + 8192; written += pad.length) {
			appendFileSync(file, pad);
		}
		const header = {
			type: "session",
			version: 3,
			id: "late",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/projects/late",
		};
		appendFileSync(file, `${JSON.stringify(header)}\n`);

		// A full listing streams the file and finds the session ...
		expect((await SessionManager.list("/projects/late", dir)).map((session) => session.id)).toEqual(["late"]);
		// ... while the header-only listing never reads that far.
		expect(await SessionManager.listHeaders("/projects/late", dir)).toEqual([]);
		expect(await SessionManager.listAllHeaders(dir)).toEqual([]);
	});

	it("skips a directory an earlier pass already listed in full", async () => {
		// Default project directories under the agent dir this test points at.
		const localDir = getDefaultSessionDirPath("/projects/a");
		const otherDir = getDefaultSessionDirPath("/projects/b");
		const local = writeSession(localDir, "a.jsonl", "aaa", "/projects/a");
		const other = writeSession(otherDir, "b.jsonl", "bbb", "/projects/b");

		expect(identity(await SessionManager.listAllHeaders(undefined))).toEqual([
			`${local}|aaa|/projects/a`,
			`${other}|bbb|/projects/b`,
		]);
		expect(identity(await SessionManager.listAllHeaders(undefined, { skipDir: localDir }))).toEqual([
			`${other}|bbb|/projects/b`,
		]);
		// Skipping a directory that is not part of the listing changes nothing.
		const unchanged = await SessionManager.listAllHeaders(undefined, { skipDir: getDefaultSessionDirPath("/nope") });
		expect(identity(unchanged)).toEqual(identity(await SessionManager.listAllHeaders(undefined)));
		expect(await SessionManager.listAllHeaders(localDir, { skipDir: localDir })).toEqual([]);
	});

	it("ignores unreadable and non-session files instead of failing the listing", async () => {
		const dir = join(tempDir, "mixed");
		const session = writeSession(dir, "good.jsonl", "good", "/projects/good");
		writeFileSync(join(dir, "notes.txt"), "not a session", "utf8");
		writeFileSync(join(dir, "broken.jsonl"), "{not json\n", "utf8");

		const expected = [`${session}|good|/projects/good`];
		expect(identity(await SessionManager.listHeaders("/projects/good", dir))).toEqual(expected);
		const missing = join(tempDir, "does-not-exist");
		expect(await SessionManager.listHeaders("/projects/good", missing)).toEqual([]);
	});
});
