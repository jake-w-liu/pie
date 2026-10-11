import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-literal-path-"));
	temporaryDirectories.push(directory);
	return directory;
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>): string {
	return result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("literal path resolution in file tools", () => {
	it.each(["ideographic\u3000space.txt", "narrow\u202fspace.txt"])(
		"reads and edits an existing literal Unicode-space path: %s",
		async (fileName) => {
			const directory = temporaryDirectory();
			const literalFile = join(directory, fileName);
			const normalizedFile = join(directory, fileName.replace(/[\u202f\u3000]/g, " "));
			writeFileSync(literalFile, "literal");
			writeFileSync(normalizedFile, "normalized");

			expect(textOf(await createReadTool(directory).execute("test", { path: fileName }))).toBe("literal");
			await createEditTool(directory).execute("test", {
				path: fileName,
				edits: [{ oldText: "literal", newText: "edited" }],
			} as never);

			expect(await readFile(literalFile, "utf8")).toBe("edited");
			expect(await readFile(normalizedFile, "utf8")).toBe("normalized");
		},
	);

	it("prefers a literal leading-@ read path and falls back to stripping @", async () => {
		const directory = temporaryDirectory();
		writeFileSync(join(directory, "@scope.txt"), "literal scope");
		writeFileSync(join(directory, "README.md"), "fallback readme");
		const tool = createReadTool(directory);

		expect(textOf(await tool.execute("test", { path: "@scope.txt" }))).toBe("literal scope");
		expect(textOf(await tool.execute("test", { path: "@README.md" }))).toBe("fallback readme");
	});

	it("normalizes a nonexistent write target", async () => {
		const directory = temporaryDirectory();
		await createWriteTool(directory).execute("test", { path: "@out\u3000file.txt", content: "written" });

		expect(await readFile(join(directory, "out file.txt"), "utf8")).toBe("written");
		await expect(access(join(directory, "@out\u3000file.txt"))).rejects.toThrow();
	});
});
