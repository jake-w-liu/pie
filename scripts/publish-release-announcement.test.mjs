import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
	advanceLatestRelease,
	buildReleaseAnnouncement,
	compareReleaseVersions,
	putImmutableObject,
} from "./publish-release-announcement.mjs";

test("builds retry-stable immutable release announcements", async () => {
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const input = {
		version: "1.2.3",
		sourceCommit,
		packages: [{ name: "@earendil-works/pi-ai", version: "1.2.3" }],
	};
	const firstWallClock = Date.now();
	const firstBody = buildReleaseAnnouncement(input);
	while (Date.now() === firstWallClock) await new Promise((resolve) => setTimeout(resolve, 1));
	const secondBody = buildReleaseAnnouncement(input);
	assert.equal(secondBody, firstBody);

	const announcement = JSON.parse(firstBody);
	const commitTimestamp = execFileSync("git", ["show", "-s", "--format=%cI", sourceCommit], {
		encoding: "utf8",
	}).trim();
	assert.equal(announcement.publishedAt, new Date(commitTimestamp).toISOString());
	assert.equal(
		await putImmutableObject({
			write: async () => false,
			readRemote: async () => Buffer.from(firstBody),
			key: "releases/v1/releases/1.2.3.json",
			body: Buffer.from(secondBody),
		}),
		false,
	);
});

test("compares stable release versions numerically", () => {
	assert.ok(compareReleaseVersions("0.85.0", "0.84.9") > 0);
	assert.ok(compareReleaseVersions("0.84.10", "0.84.9") > 0);
	assert.equal(compareReleaseVersions("0.84.0", "0.84.0"), 0);
	assert.throws(() => compareReleaseVersions("0.85.0-beta.1", "0.84.0"));
});

test("does not regress an existing newer release marker", async () => {
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => ({ etag: '"newer"', version: "0.85.0" }),
		async () => {
			writeCount++;
			return true;
		},
	);

	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 0);
});

test("retries a lost conditional update and preserves a racing newer marker", async () => {
	let readCount = 0;
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => {
			readCount++;
			return readCount === 1
				? { etag: '"previous"', version: "0.83.0" }
				: { etag: '"newer"', version: "0.85.0" };
		},
		async (condition) => {
			writeCount++;
			assert.deepEqual(condition, { etag: '"previous"' });
			return false;
		},
	);

	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 1);
});

test("creates a missing marker with an if-none-match condition", async () => {
	let condition;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => undefined,
		async (value) => {
			condition = value;
			return true;
		},
	);

	assert.deepEqual(result, { advanced: true, version: "0.84.0" });
	assert.deepEqual(condition, { missing: true });
});

test("an idempotent immutable write proceeds when the existing object matches", async () => {
	const body = Buffer.from('{"version":"0.85.0"}\n');
	const result = await putImmutableObject({
		write: async () => false,
		readRemote: async () => body,
		key: "releases/v1/releases/0.85.0.json",
		body,
	});

	assert.equal(result, false);
});

test("an idempotent immutable write fails before pointers move when the existing object differs", async () => {
	await assert.rejects(
		putImmutableObject({
			write: async () => false,
			readRemote: async () => Buffer.from('{"version":"0.85.0","sourceCommit":"other"}\n'),
			key: "releases/v1/releases/0.85.0.json",
			body: Buffer.from('{"version":"0.85.0"}\n'),
		}),
		/already exists with different content/,
	);
});

test("an idempotent immutable write fails when the object is neither written nor readable", async () => {
	await assert.rejects(
		putImmutableObject({
			write: async () => false,
			readRemote: async () => undefined,
			key: "installer/v1/releases/0.85.0/package.json",
			body: Buffer.from("{}\n"),
		}),
		/could not be written and is absent/,
	);
});

test("a first-time immutable write does not read the remote object", async () => {
	let reads = 0;
	const result = await putImmutableObject({
		write: async () => true,
		readRemote: async () => {
			reads++;
			return undefined;
		},
		key: "releases/v1/releases/0.85.0.json",
		body: Buffer.from("{}\n"),
	});

	assert.equal(result, true);
	assert.equal(reads, 0);
});
