import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, repairJson } from "../src/utils/json-parse.ts";

describe("JSON escape repair", () => {
	it("repairs malformed Unicode escapes as literal backslashes", () => {
		const malformed = String.raw`{"path":"C:\users"}`;

		expect(repairJson(malformed)).toBe(String.raw`{"path":"C:\\users"}`);
		expect(parseJsonWithRepair<{ path: string }>(malformed)).toEqual({ path: String.raw`C:\users` });
	});

	it("preserves valid Unicode escapes", () => {
		expect(parseJsonWithRepair<{ letter: string }>(String.raw`{"letter":"\u0041"}`)).toEqual({ letter: "A" });
	});
});
