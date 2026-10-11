import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

/**
 * The export embeds template.js, marked.min.js and highlight.min.js into the
 * generated page. Substituting them with a replacement *string* runs them through
 * GetSubstitution, so "$$", "$&", "$`" and "$'" inside those bundles are rewritten
 * to the placeholder or to the surrounding text. The result still renders, so the
 * damage is silent: a dropped "$" in the cost label and a broken operator regex in
 * the highlighter.
 */
describe("export HTML embeds its assets verbatim", () => {
	it("embeds template.js and highlight.min.js byte-identically", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pie-export-assets-"));
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: new Date().toISOString(), cwd: dir }),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
				}),
				"",
			].join("\n"),
		);

		const outputPath = join(dir, "out.html");
		const exported = await exportSessionToHtml(SessionManager.open(sessionFile), undefined, { outputPath });
		const html = readFileSync(exported, "utf-8");

		const templateDir = new URL("../src/core/export-html/", import.meta.url);
		for (const asset of ["template.js", "vendor/marked.min.js", "vendor/highlight.min.js"]) {
			const contents = readFileSync(new URL(asset, templateDir), "utf-8");
			expect(html, `${asset} must appear verbatim in the export`).toContain(contents);
		}
	}, 30_000);
});
