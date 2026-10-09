import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findContent } from "../../../../pi-web-access/content-find.ts";
import { HeadroomController } from "../../../src/core/headroom.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness;
beforeEach(async () => {
	harness = await createHarness({ settings: { compaction: { enabled: false } } });
	harness.setResponses([fauxAssistantMessage("observed")]);
	await harness.session.prompt("offline fixture");
});
afterEach(() => harness.cleanup());

function history(...texts: string[]): AgentMessage[] {
	return [
		...texts.map((text, index) => ({
			role: "toolResult" as const,
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text" as const, text }],
			isError: false,
			timestamp: index,
		})),
		harness.session.messages.at(-1)!,
	];
}

function markerHashes(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "toolResult"
			? message.content.flatMap((block) =>
					block.type === "text"
						? [...block.text.matchAll(/hash="([a-f0-9]{64})"/g)].map((match) => match[1]!)
						: [],
				)
			: [],
	);
}

const template = readFileSync(new URL("../../../src/core/export-html/template.js", import.meta.url), "utf8");
function renderExport(entries: unknown[]) {
	const encoded = Buffer.from(JSON.stringify({ header: {}, entries, leafId: null })).toString("base64");
	const { document } = parseHTML(
		`<html><body><script id="session-data" type="application/json">${encoded}</script></body></html>`,
	);
	const context = vm.createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document,
		window: { location: { search: "" } },
	});
	const initialization = template.indexOf("      // Configure marked with syntax highlighting");
	expect(initialization).toBeGreaterThan(0);
	const script = `${template.slice(0, initialization)}
	for (const entry of entries) {
		const node = renderEntryToNode(entry);
		if (node) document.body.appendChild(node);
	}
	for (const node of buildTree()) {
		const row = document.createElement('div');
		row.className = 'tree-fixture';
		row.innerHTML = getTreeNodeDisplayHtml(node.entry, node.label);
		document.body.appendChild(row);
	}
	})();`;
	new vm.Script(script).runInContext(context, { timeout: 1000 });
	return document;
}

function readEntry(args: Record<string, unknown>) {
	return {
		type: "message",
		id: "call-entry",
		parentId: null,
		timestamp: 1,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.txt", ...args } }],
		},
	};
}

describe("legacy cross-project forks", () => {
	it.each([1, 2, 3])("migrates v%s history without changing its source", (version) => {
		const legacy = version === 1;
		const sourceEntries = [
			{ type: "session", id: "source", version, cwd: harness.tempDir, timestamp: "2025-01-01T00:00:00Z" },
			{
				type: "message",
				...(legacy ? {} : { id: "user", parentId: null }),
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "retained", timestamp: 1 },
			},
			{
				type: "message",
				...(legacy ? {} : { id: "custom", parentId: "user" }),
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: version < 3 ? "hookMessage" : "custom",
					customType: "fixture",
					content: "legacy custom",
					display: true,
					timestamp: 2,
				},
			},
		];
		const source = `${sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const path = join(harness.tempDir, `v${version}.jsonl`);
		writeFileSync(path, source);
		const fork = SessionManager.forkFrom(path, join(harness.tempDir, "target"), join(harness.tempDir, "forks"));
		expect(fork.getHeader()).toMatchObject({ version: 3, parentSession: path });
		expect(fork.getBranch()).toHaveLength(2);
		expect(fork.getBranch()[0].parentId).toBeNull();
		expect(fork.getBranch()[1].parentId).toBe(fork.getBranch()[0].id);
		expect(fork.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: "retained" },
			{ role: "custom", content: "legacy custom" },
		]);
		expect(readFileSync(path, "utf8")).toBe(source);
		if (!legacy) expect(fork.getBranch().map((entry) => entry.id)).toEqual(["user", "custom"]);
		expect(SessionManager.open(fork.getSessionFile()!, join(harness.tempDir, "forks")).getBranch()).toEqual(
			fork.getBranch(),
		);
	});

	it("migrates legacy compaction indexes before replacing the header", () => {
		const path = join(harness.tempDir, "compacted.jsonl");
		const entries = [
			{ type: "session", id: "source", version: 1, cwd: harness.tempDir, timestamp: "2025-01-01T00:00:00Z" },
			{ type: "message", message: { role: "user", content: "old", timestamp: 1 } },
			{ type: "message", message: { role: "user", content: "kept", timestamp: 2 } },
			{ type: "compaction", summary: "summary", tokensBefore: 42, firstKeptEntryIndex: 2 },
		];
		const source = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(path, source);
		const fork = SessionManager.forkFrom(path, harness.tempDir, join(harness.tempDir, "forks"));
		const branch = fork.getBranch();
		expect(branch).toHaveLength(3);
		expect(branch[2]).toMatchObject({ type: "compaction", firstKeptEntryId: branch[1].id });
		expect(branch[2]).not.toHaveProperty("firstKeptEntryIndex");
		expect(fork.buildSessionContext().messages).toMatchObject([
			{ role: "compactionSummary" },
			{ role: "user", content: "kept" },
		]);
		expect(readFileSync(path, "utf8")).toBe(source);
	});
});

describe("request-feasible Headroom originals", () => {
	it.each([{ maxStoreEntries: 1 }, { maxStoreEntries: 3, maxStoreChars: 12000 }])(
		"keeps every emitted hash available within %j",
		(limits) => {
			const controller = new HeadroomController({ env: {}, ...limits });
			const input = history("A".repeat(12000), "B".repeat(12000));
			const original = structuredClone(input);
			const projected = controller.projectContext(input, true);
			expect(controller.getStoreStats().entries).toBe(0);
			const output = controller.transformContext(input, true);
			const hashes = markerHashes(output);
			expect(hashes).toHaveLength(1);
			expect(markerHashes(projected)).toHaveLength(hashes.length);
			expect(controller.retrieve(hashes[0])?.content).toBe("A".repeat(12000));
			expect(output[1]).toBe(input[1]);
			expect(input).toEqual(original);
		},
	);

	it("counts duplicate hashes once, including cache hits with old insertion order", () => {
		const a = "A".repeat(12000),
			b = "B".repeat(12000),
			c = "C".repeat(12000);
		const controller = new HeadroomController({ env: {}, maxStoreEntries: 2 });
		controller.transformContext(history(a, b), true);
		const output = controller.transformContext(history(a, c, a), true);
		const hashes = markerHashes(output);
		expect(hashes).toHaveLength(3);
		expect(new Set(hashes).size).toBe(2);
		for (const hash of hashes) expect(controller.retrieveFormatted(hash).ok).toBe(true);
		expect(controller.getStoreStats()).toMatchObject({ entries: 2, chars: 24000 });
		expect(markerHashes(controller.projectContext(history(a, c, a), true))).toHaveLength(3);
	});

	it("uses UTF-8 byte capacity and leaves fresh, protected, small or unavailable-retrieval content intact", () => {
		const controller = new HeadroomController({ env: {}, maxStoreChars: 36000 });
		const input = history("中".repeat(12000), "B".repeat(12000));
		expect(markerHashes(controller.projectContext(input, true))).toHaveLength(1);
		const output = controller.transformContext(input, true);
		expect(markerHashes(output)).toHaveLength(1);
		expect(controller.getStoreStats().chars).toBe(36000);
		const fresh = input.slice(0, 2);
		expect(controller.transformContext(fresh, true)).toBe(fresh);
		expect(controller.transformContext(input, false)).toBe(input);
		const protectedInput = history(`<headroom_compressed hash="original">${"X".repeat(12000)}`, "small");
		expect(controller.transformContext(protectedInput, true)).toBe(protectedInput);
		controller.setEnabled(false);
		expect(controller.transformContext(input, true)).toBe(input);
	});
});

describe("persisted scalar HTML boundaries", () => {
	it.each(["offset", "limit"])("rejects malformed read %s without creating attacker markup", (field) => {
		const document = renderExport([readEntry({ [field]: '<img src=x onerror="globalThis.__piExportXss=1">' })]);
		expect(document.querySelectorAll("img[onerror]")).toHaveLength(0);
		expect(document.querySelector(".tool-path")?.textContent).toContain("[invalid arg]");
	});
	it.each([
		[{ offset: 3, limit: 4 }, ":3-6"],
		[{ offset: Number.MAX_SAFE_INTEGER, limit: 1 }, `:${Number.MAX_SAFE_INTEGER}-${Number.MAX_SAFE_INTEGER}`],
		[{ offset: Number.MAX_SAFE_INTEGER, limit: 2 }, "[invalid arg]"],
		[{ offset: null }, "[invalid arg]"],
		[{ limit: -1 }, "[invalid arg]"],
	] as const)("handles read numeric boundaries %j", (args, expected) => {
		expect(renderExport([readEntry(args)]).querySelector(".tool-path")?.textContent).toContain(expected);
	});
	it.each([null, '<img src=x onerror="globalThis.__piExportXss=1">'])(
		"contains malformed imported compaction tokens %j",
		(tokensBefore) => {
			const document = renderExport([
				{ type: "compaction", id: "compaction", parentId: null, tokensBefore, summary: "kept", timestamp: 1 },
			]);
			expect(document.querySelectorAll("img[onerror]")).toHaveLength(0);
			expect(document.querySelector(".compaction")?.textContent).toContain("[invalid token count]");
		},
	);
	it("escapes malformed Bash exit status at the real DOM sink", () => {
		const payload = '<img src=x onerror="globalThis.__piExportXss=1">';
		const document = renderExport([
			{
				type: "message",
				id: "bash",
				parentId: null,
				timestamp: 1,
				message: { role: "bashExecution", command: "offline", exitCode: payload },
			},
		]);
		expect(document.querySelectorAll("img[onerror]")).toHaveLength(0);
		expect(document.querySelector(".tool-execution")?.textContent).toContain(payload);
	});
	it.each([undefined, ""])("replays exported label clearing (%j)", (label) => {
		const entry = readEntry({});
		const document = renderExport([
			entry,
			{ type: "label", id: "label", parentId: entry.id, targetId: entry.id, label: "removed" },
			{ type: "label", id: "clear", parentId: "label", targetId: entry.id, label },
		]);
		expect(document.querySelector(".tree-label")).toBeNull();
	});
});

describe("content finding fidelity and budget", () => {
	it.each(["ΟΣ", "Οσ", "ος"].flatMap((text) => ["ΟΣ", "Οσ", "ος"].map((query) => ({ text, query }))))(
		"matches sigma case variants ($text / $query) like native /iu",
		({ text, query }) => {
			expect(new RegExp(query, "iu").test(text)).toBe(true);
			const result = findContent(text, [query], "case-insensitive");
			expect(result).toMatchObject({ matchCount: 1, returnedMatches: 1 });
			expect(result.text).toContain(text);
		},
	);
	it("keeps exact search case-sensitive for sigma variants", () => {
		expect(findContent("ΟΣ", ["ος"], "exact").matchCount).toBe(0);
	});
	it.each(["😀", "𠀀"])("finds original excerpts after astral prefixes (%s)", (prefix) => {
		const result = findContent(`${prefix.repeat(800)}NeEdLe${"x".repeat(2000)}`, ["needle"], "case-insensitive");
		expect(result).toMatchObject({ matchCount: 1, returnedMatches: 1 });
		expect(result.text).toContain("NeEdLe");
	});
	it("maps full original boundaries for length-expanding lowercase and partial folds", () => {
		const result = findContent(
			`${"😀".repeat(800)}İneedle${"x".repeat(2000)}`,
			["i", "needle", "i\u0307needle"],
			"case-insensitive",
		);
		expect(result).toMatchObject({ matchCount: 3, returnedMatches: 3 });
		expect(result.text).toContain("İneedle");
	});
	it.each(["a ".repeat(15000), "needle ".repeat(5000)])(
		"returns bounded dense excerpts, counting only fully included matches",
		(text) => {
			const query = text.trim().split(" ")[0];
			const result = findContent(text, [query], "exact");
			expect(result.returnedMatches).toBeGreaterThan(0);
			expect(result.returnedMatches).toBeLessThan(result.matchCount);
			expect(result.text.length).toBeLessThanOrEqual(20000);
			const snippet = result.text.split("\n")[3];
			expect(snippet.split(query).length - 1).toBe(result.returnedMatches);
			expect(result.text).toContain(`Showing ${result.returnedMatches} of ${result.matchCount} matches.`);
		},
	);
	it("includes headings and truncation notices in the multiple-range budget", () => {
		const text = Array.from({ length: 40 }, (_, index) => `match-${index}${"x".repeat(1000)}`).join("\n");
		const result = findContent(text, ["match", "missing"], "exact");
		expect(result.returnedMatches).toBeGreaterThan(1);
		expect(result.returnedMatches).toBeLessThan(40);
		expect(result.text.length).toBeLessThanOrEqual(20000);
		expect(result.text).toContain(`Showing ${result.returnedMatches} of 40 matches.`);
	});
	it("never counts a partially represented long match or exceeds its budget", () => {
		const query = "q".repeat(21000);
		const result = findContent(query, [query], "exact");
		expect(result).toMatchObject({ matchCount: 1, returnedMatches: 0 });
		expect(result.text.length).toBeLessThanOrEqual(20000);
		expect(result.text).toContain("Showing 0 of 1 matches.");
	});
});

describe("scalar-safe content excerpt boundaries", () => {
	it("distinguishes lone surrogate halves from complete astral scalars", () => {
		expect("😀𠀀").not.toMatch(/\p{Surrogate}/u);
		expect("\ud83d").toMatch(/\p{Surrogate}/u);
		expect("\ude00").toMatch(/\p{Surrogate}/u);
	});
	for (const mode of ["exact", "case-insensitive", "fuzzy"] as const) {
		it.each(["😀", "𠀀"])(`${mode} keeps a complete left-boundary scalar (%s)`, (scalar) => {
			const result = findContent(`${scalar}${".".repeat(399)}needle`, ["needle"], mode);
			expect(result).toMatchObject({ matchCount: 1, returnedMatches: 1 });
			expect(result.text).not.toMatch(/\p{Surrogate}/u);
			expect(result.text).toContain(scalar);
			expect(result.text).toContain("needle");
			expect(result.text.length).toBeLessThanOrEqual(20000);
		});
		it.each(["😀", "𠀀"])(`${mode} does not split a right-boundary scalar (%s)`, (scalar) => {
			const result = findContent(`needle${".".repeat(399)}${scalar}tail`, ["needle"], mode);
			expect(result).toMatchObject({ matchCount: 1, returnedMatches: 1 });
			expect(result.text).not.toMatch(/\p{Surrogate}/u);
			expect(result.text).toContain(scalar);
			expect(result.text).toContain("needle");
			expect(result.text.length).toBeLessThanOrEqual(20000);
		});
		it("keeps dense scalar-rich output bounded without altering represented counts", () => {
			const query = "needle";
			const paragraph = `😀 . ${query} . 𠀀 \n\n`;
			// Shift every position of the repeated paragraph across the budget edge.
			for (let prefixLength = 0; prefixLength < paragraph.length; prefixLength++) {
				const result = findContent(`${".".repeat(prefixLength)}${paragraph.repeat(3000)}`, [query], mode);
				expect(result.text).not.toMatch(/\p{Surrogate}/u);
				expect(result.matchCount).toBe(3000);
				expect(result.returnedMatches).toBeGreaterThan(0);
				expect(result.returnedMatches).toBeLessThan(3000);
				expect(result.text.length).toBeLessThanOrEqual(20000);
				expect(result.text.split("\n")[3].split(query).length - 1).toBe(result.returnedMatches);
			}
		});
	}
});
