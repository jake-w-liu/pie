#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { AuthPrompt, OAuthCredential, Provider } from "./index.ts";
import { builtinProviders } from "./providers/all.ts";

const AUTH_FILE = "auth.json";
const PROVIDERS = builtinProviders().filter(
	(provider): provider is Provider & { auth: { oauth: NonNullable<Provider["auth"]["oauth"]> } } =>
		provider.auth.oauth !== undefined,
);

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Read the credential file. A file that exists but cannot be read is fatal:
 * returning `{}` here would make the next `saveAuth` truncate it, logging the
 * user out of every other provider. Repair or delete the file instead.
 */
function loadAuth(): Record<string, OAuthCredential> {
	if (!existsSync(AUTH_FILE)) return {};
	let raw: string;
	try {
		raw = readFileSync(AUTH_FILE, "utf-8");
	} catch (error) {
		throw new Error(`Cannot read ${AUTH_FILE}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`${AUTH_FILE} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
				`Repair or delete it, then log in again.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${AUTH_FILE} must contain a JSON object of provider credentials. Repair or delete it.`);
	}
	return parsed as Record<string, OAuthCredential>;
}

function saveAuth(auth: Record<string, OAuthCredential>): void {
	// Same contract as the coding agent's auth storage: OAuth access and refresh
	// tokens are written owner-only, and an existing file is tightened too. The write
	// goes to an owner-only temporary sibling and is renamed over the target: a direct
	// `writeFileSync` truncated every stored credential before the replacement was
	// durable, so an interruption left an unparseable auth file.
	const directory = dirname(AUTH_FILE);
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `.${basename(AUTH_FILE)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
	try {
		writeFileSync(temporary, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, AUTH_FILE);
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Preserve the write/rename failure; cleanup is best effort.
		}
		throw error;
	}
	chmodSync(AUTH_FILE, 0o600);
}

async function answerPrompt(rl: ReturnType<typeof createInterface>, authPrompt: AuthPrompt): Promise<string> {
	if (authPrompt.type === "select") {
		console.log(`\n${authPrompt.message}`);
		for (let index = 0; index < authPrompt.options.length; index++) {
			console.log(`  ${index + 1}. ${authPrompt.options[index].label}`);
		}
		const choice = Number.parseInt(await prompt(rl, `Enter number (1-${authPrompt.options.length}): `), 10) - 1;
		const selected = authPrompt.options[choice];
		if (!selected) throw new Error("Invalid selection");
		return selected.id;
	}
	return prompt(rl, `${authPrompt.message}${authPrompt.placeholder ? ` (${authPrompt.placeholder})` : ""}: `);
}

async function login(providerId: string): Promise<void> {
	const provider = PROVIDERS.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const credential = await provider.auth.oauth.login({
			signal: new AbortController().signal,
			prompt: (authPrompt) => answerPrompt(rl, authPrompt),
			notify: (event) => {
				switch (event.type) {
					case "auth_url":
						console.log(`\nOpen this URL in your browser:\n${event.url}`);
						if (event.instructions) console.log(event.instructions);
						break;
					case "device_code":
						console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
						console.log(`Enter code: ${event.userCode}`);
						break;
					case "info":
					case "progress":
						console.log(event.message);
						break;
				}
			},
		});
		const auth = loadAuth();
		auth[providerId] = credential;
		saveAuth(auth);
		console.log(`\nCredentials saved to ${AUTH_FILE}`);
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	if (!command || command === "help" || command === "--help" || command === "-h") {
		const providerList = PROVIDERS.map((provider) => `  ${provider.id.padEnd(20)} ${provider.name}`).join("\n");
		console.log(
			`Usage: npx @earendil-works/pi-ai <command> [provider]\n\nCommands:\n  login [provider]  Login to an OAuth provider\n  list              List available providers\n\nProviders:\n${providerList}`,
		);
		return;
	}
	if (command === "list") {
		for (const provider of PROVIDERS) console.log(`${provider.id.padEnd(20)} ${provider.name}`);
		return;
	}
	if (command === "login") {
		let providerId = args[1];
		if (!providerId) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				for (let index = 0; index < PROVIDERS.length; index++) {
					console.log(`  ${index + 1}. ${PROVIDERS[index].name}`);
				}
				const index = Number.parseInt(await prompt(rl, `Enter number (1-${PROVIDERS.length}): `), 10) - 1;
				providerId = PROVIDERS[index]?.id;
			} finally {
				rl.close();
			}
		}
		if (!providerId || !PROVIDERS.some((provider) => provider.id === providerId)) {
			throw new Error(`Unknown provider: ${providerId ?? ""}`);
		}
		await login(providerId);
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
