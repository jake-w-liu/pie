import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Cookie selection in `chrome-cookies.ts` is by exact `host_key`, so a profile's
 * cookies follow its configured host. Treating a bare host as covering every subdomain
 * therefore attached `example.com` cookies to requests against
 * `attacker.example.com`. Subdomain coverage is now opt-in with a leading dot.
 *
 * `auth-fetch.ts` resolves its config path at module load, so each case resets the
 * module registry and re-imports after pointing `PI_CODING_AGENT_DIR` at a fixture.
 */
type Profile = { name: string; hosts: string[]; redirects: "same-origin"; cache: "session" };

async function loadWithConfig(config: unknown): Promise<{
	assertAuthFetchUrl: (profile: Profile, url: string) => URL;
	resolveAuthFetchProfile: (value: unknown) => Profile | undefined;
}> {
	const scratch = mkdtempSync(join(tmpdir(), "pi-auth-fetch-hosts-"));
	tempDirs.push(scratch);
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(scratch, "web-search.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = scratch;
	vi.resetModules();
	return import("../../pi-web-access/auth-fetch.ts") as never;
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authFetch host scope", () => {
	it("does not treat a bare host as covering its subdomains", { timeout: 30_000 }, async () => {
		const { assertAuthFetchUrl, resolveAuthFetchProfile } = await loadWithConfig({
			authFetch: { test: { hosts: ["example.com"] } },
		});
		const profile = resolveAuthFetchProfile("test");
		expect(profile).toBeDefined();
		expect(() => assertAuthFetchUrl(profile!, "https://example.com/page")).not.toThrow();
		expect(() => assertAuthFetchUrl(profile!, "https://attacker.example.com/page")).toThrow(/not allowed/);
		expect(() => assertAuthFetchUrl(profile!, "https://deep.sub.example.com/page")).toThrow(/not allowed/);
	});

	it("covers subdomains only when the entry opts in with a leading dot", { timeout: 30_000 }, async () => {
		const { assertAuthFetchUrl, resolveAuthFetchProfile } = await loadWithConfig({
			authFetch: { test: { hosts: [".example.com"] } },
		});
		const profile = resolveAuthFetchProfile("test");
		expect(profile).toBeDefined();
		expect(() => assertAuthFetchUrl(profile!, "https://example.com/page")).not.toThrow();
		expect(() => assertAuthFetchUrl(profile!, "https://attacker.example.com/page")).not.toThrow();
		expect(() => assertAuthFetchUrl(profile!, "https://notexample.com/page")).toThrow(/not allowed/);
	});
});
