import { describe, expect, it } from "vitest";
import { isOfflineModeEnabled, isTruthyEnvFlag } from "../src/utils/env.ts";

describe("env flags", () => {
	it("treats 1/true/yes (any case) as truthy and everything else as falsy", () => {
		for (const value of ["1", "true", "TRUE", "True", "yes", "YES", "Yes"]) {
			expect(isTruthyEnvFlag(value)).toBe(true);
		}
		for (const value of [undefined, "", "0", "false", "no", "off", "2"]) {
			expect(isTruthyEnvFlag(value)).toBe(false);
		}
	});

	it("derives offline mode from PI_OFFLINE without split-brain on falsy values", () => {
		const previous = process.env.PI_OFFLINE;
		try {
			delete process.env.PI_OFFLINE;
			expect(isOfflineModeEnabled()).toBe(false);
			process.env.PI_OFFLINE = "0";
			expect(isOfflineModeEnabled()).toBe(false);
			process.env.PI_OFFLINE = "false";
			expect(isOfflineModeEnabled()).toBe(false);
			process.env.PI_OFFLINE = "1";
			expect(isOfflineModeEnabled()).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previous;
		}
	});
});
