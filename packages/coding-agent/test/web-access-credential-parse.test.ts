import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `web-search.json` and the Gemini ADC file are the credential stores: their own text
 * is the secret. V8's `JSON.parse` message quotes the source around the offending
 * token, so interpolating that message into an error handed back to the model (or
 * printed by the extension host) leaks a fragment of the credential. Only the parse
 * position may be repeated.
 */
const SENTINEL = "sk-live-SENTINEL123";

describe("credential store parse diagnostics", () => {
	let root: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let previousAdc: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-credential-parse-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.GOOGLE_APPLICATION_CREDENTIALS = join(root, "adc.json");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousAdc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousAdc;
		rmSync(root, { recursive: true, force: true });
	});

	function expectNoCredentialText(message: string): void {
		expect(message).not.toContain(SENTINEL);
		expect(message).not.toContain("is not valid JSON");
		expect(message).not.toMatch(/Unexpected token/);
	}

	it("does not echo credential text when web-search.json is malformed", async () => {
		writeFileSync(join(agentDir, "web-search.json"), `{"braveApiKey": ${SENTINEL}}`);
		const { searchWithBrave } = await import("../../pi-web-access/brave.ts");

		await expect(searchWithBrave("q", {})).rejects.toSatisfy((error: Error) => {
			expectNoCredentialText(error.message);
			expect(error.message).toContain("not valid JSON");
			return true;
		});
	});

	it("does not echo credential text when the Gemini ADC file is malformed", async () => {
		writeFileSync(join(root, "adc.json"), `{"client_secret": ${SENTINEL}}`);
		const { getAdcAccessToken } = await import("../../pi-web-access/gemini-adc.ts");

		await expect(getAdcAccessToken()).rejects.toSatisfy((error: Error) => {
			expectNoCredentialText(error.message);
			expect(error.message).toContain("not valid JSON");
			return true;
		});
	});

	it("does not report a parse failure for a structurally valid JSON file", async () => {
		writeFileSync(join(agentDir, "web-search.json"), '["not", "an", "object"]');
		const { searchWithBrave } = await import("../../pi-web-access/brave.ts");

		// Valid JSON that is not a usable config must surface the normal
		// missing-credential diagnostic, never a "Failed to parse" message.
		await expect(searchWithBrave("q", {})).rejects.toThrow(/API key not found/);
	});
});
