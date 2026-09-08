import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function request(child: ChildProcess, command: string): Promise<{ path: string; content: string }> {
	const result = once(child, "message");
	child.send(command);
	const [value] = await result;
	return value;
}

it("keeps two extension owners' clones and cleanup independent under one configured base", async () => {
	const root = mkdtempSync(join(tmpdir(), "pie-clone-owners-"));
	const children: ChildProcess[] = [];
	try {
		const base = join(root, "clones");
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ githubClone: { clonePath: base } }));
		writeFileSync(
			join(bin, "gh"),
			`#!${process.execPath}
const fs = require("node:fs"); const path = require("node:path"); const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] !== "repo" || args[1] !== "clone") process.exit(2);
fs.mkdirSync(args[3], { recursive: true }); fs.writeFileSync(path.join(args[3], "README.md"), process.env.OWNER);
`,
			{ mode: 0o700 },
		);
		const script = join(root, "owner.mjs");
		const modulePath = fileURLToPath(new URL("../../pi-web-access/github-extract.ts", import.meta.url));
		writeFileSync(
			script,
			`import { extractGitHub, clearCloneCache } from ${JSON.stringify(modulePath)};
process.on("message", async command => {
 if (command === "clear") { clearCloneCache(); process.send({ path: "", content: "" }); return; }
 const result = await extractGitHub("https://github.com/fixture/project", undefined, true);
 process.send({ path: result.content.split("\\n")[0].slice("Repository cloned to: ".length), content: result.content });
});`,
		);
		for (const owner of ["owner-a", "owner-b"]) {
			children.push(
				spawn(process.execPath, [script], {
					env: { PATH: bin, HOME: root, PI_CODING_AGENT_DIR: root, PIE_CODING_AGENT_DIR: root, OWNER: owner },
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				}),
			);
		}
		const first = await request(children[0]!, "fetch");
		const second = await request(children[1]!, "fetch");
		expect(second.path).not.toBe(first.path);
		expect(dirname(first.path)).not.toBe(dirname(second.path));
		expect(statSync(dirname(first.path)).mode & 0o777).toBe(0o700);
		expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("owner-a");
		await request(children[1]!, "clear");
		expect(existsSync(second.path)).toBe(false);
		expect((await request(children[0]!, "fetch")).path).toBe(first.path);
		expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("owner-a");
		const renewed = await request(children[1]!, "fetch");
		expect(renewed.path).not.toBe(first.path);
		await request(children[0]!, "clear");
		expect(existsSync(first.path)).toBe(false);
		expect(readFileSync(join(renewed.path, "README.md"), "utf8")).toBe("owner-b");
	} finally {
		await Promise.all(
			children.map(async (child) => {
				const exit = once(child, "exit");
				child.kill();
				await exit;
			}),
		);
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
