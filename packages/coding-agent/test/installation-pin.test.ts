import { spawnSync } from "node:child_process";
import { fstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pinInstallation } from "../src/core/installation-pin.ts";

const root = mkdtempSync(join(tmpdir(), "pie-installation-pin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasLsof = process.platform !== "win32" && spawnSync("lsof", ["-v"]).error === undefined;

describe.skipIf(process.platform === "win32")("pinInstallation", () => {
	it("keeps one descriptor on the installation file open for the process", () => {
		const file = join(root, "package.json");
		writeFileSync(file, "{}\n");

		const descriptor = pinInstallation(file);

		expect(descriptor).toBeTypeOf("number");
		const pinned = fstatSync(descriptor as number);
		const actual = statSync(file);
		expect([pinned.dev, pinned.ino]).toEqual([actual.dev, actual.ino]);
		// Later calls keep the first descriptor instead of opening more.
		expect(pinInstallation(join(root, "other.json"))).toBe(descriptor);

		if (hasLsof) {
			// scripts/refresh-pie.sh finds processes that use a release through this listing.
			const listing = spawnSync("lsof", ["-n", "-P", "-a", "-p", String(process.pid), "-F", "n"], {
				encoding: "utf8",
			}).stdout;
			expect(listing.split("\n")).toContain(`n${realpathSync(file)}`);
		}
	});
});
