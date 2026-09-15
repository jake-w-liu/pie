import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

describe("audit auth file permissions (P9)", () => {
	const tempDir = join(tmpdir(), `pi-audit-auth-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJsonPath = join(tempDir, "auth.json");

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function modeOf(): number {
		return statSync(authJsonPath).mode & 0o777;
	}

	it("tightens a permissive pre-existing auth.json on sync write", () => {
		writeFileSync(authJsonPath, "{}");
		chmodSync(authJsonPath, 0o644);
		expect(modeOf()).toBe(0o644);

		const backend = new FileAuthStorageBackend(authJsonPath);
		backend.withLock(() => ({ result: undefined, next: JSON.stringify({ a: 1 }) }));

		expect(modeOf()).toBe(0o600);
	});

	it("tightens a permissive pre-existing auth.json on async write", async () => {
		writeFileSync(authJsonPath, "{}");
		chmodSync(authJsonPath, 0o644);

		const backend = new FileAuthStorageBackend(authJsonPath);
		await backend.withLockAsync(async () => ({ result: undefined, next: JSON.stringify({ a: 1 }) }));

		expect(modeOf()).toBe(0o600);
	});

	it("leaves an already-restrictive mode untouched", () => {
		writeFileSync(authJsonPath, "{}");
		chmodSync(authJsonPath, 0o600);

		const backend = new FileAuthStorageBackend(authJsonPath);
		backend.withLock(() => ({ result: undefined, next: JSON.stringify({ a: 2 }) }));

		expect(modeOf()).toBe(0o600);
	});
});
