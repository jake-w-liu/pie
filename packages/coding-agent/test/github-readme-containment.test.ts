import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCloneCache, extractGitHub } from "../../pi-web-access/github-extract.ts";

const fixture = vi.hoisted(() => ({
	configPath: `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/pie-readme-config-${process.pid}-${Date.now()}.json`,
	populate: (_path: string): void => {
		throw new Error("Clone fixture not configured");
	},
}));
vi.mock("../../pi-web-access/utils.ts", () => ({ getWebSearchConfigPath: () => fixture.configPath }));
vi.mock("../../pi-web-access/github-api.ts", () => ({
	checkGhAvailable: async () => true,
	checkRepoSize: async () => 1,
	fetchViaApi: vi.fn(() => {
		throw new Error("Unexpected GitHub API access");
	}),
	showGhHint: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	execFile: vi.fn(() => {
		throw new Error("Unexpected subprocess");
	}),
	spawn: vi.fn((_command: string, args: string[]) => {
		const child = new EventEmitter();
		queueMicrotask(() => {
			try {
				const destination = args[3];
				mkdirSync(destination, { recursive: true });
				fixture.populate(destination);
				child.emit("close", 0);
			} catch (error) {
				child.emit("error", error);
			}
		});
		return child;
	}),
}));

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pie-readme-containment-"));
	writeFileSync(fixture.configPath, JSON.stringify({ githubClone: { clonePath: join(root, "clones") } }));
});
afterEach(() => {
	clearCloneCache();
	rmSync(root, { recursive: true, force: true });
	rmSync(fixture.configPath, { force: true });
});

describe("GitHub root README containment", () => {
	it.each([false, true])(
		"does not include external symlink contents, including cached fetches (relative=%s)",
		async (useRelative) => {
			const outside = join(root, "private.txt");
			writeFileSync(outside, "PRIVATE-CONTENT-MUST-NOT-LEAK");
			fixture.populate = (path) => {
				symlinkSync(useRelative ? relative(path, outside) : outside, join(path, "README.md"));
				writeFileSync(join(path, "README.txt"), "Safe fallback README");
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await extractGitHub("https://github.com/example/project", undefined, true);
				expect(readFileSync(outside, "utf8")).toBe("PRIVATE-CONTENT-MUST-NOT-LEAK");
				expect(result?.error).toBeNull();
				expect(result?.content).not.toContain("PRIVATE-CONTENT-MUST-NOT-LEAK");
				expect(result?.content).toContain("Safe fallback README");
			}
		},
	);

	it("allows symlinks whose resolved target stays in the clone", async () => {
		fixture.populate = (path) => {
			mkdirSync(join(path, "docs"));
			writeFileSync(join(path, "docs", "intro.md"), "Internal README content");
			symlinkSync("docs/intro.md", join(path, "README.md"));
		};
		const result = await extractGitHub("https://github.com/example/project", undefined, true);
		expect(result?.content).toContain("Internal README content");
	});

	it("continues past a broken symlink to a regular README", async () => {
		fixture.populate = (path) => {
			symlinkSync("missing.md", join(path, "README.md"));
			writeFileSync(join(path, "README.txt"), "Regular README content");
		};
		const result = await extractGitHub("https://github.com/example/project", undefined, true);
		expect(result?.content).toContain("Regular README content");
	});
});
