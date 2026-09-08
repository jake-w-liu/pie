import { describe, expect, it } from "vitest";
import { formatThrownValue } from "../src/utils/diagnostics.ts";

describe("thrown-value diagnostics", () => {
	it("preserves ordinary messages and string conversions", () => {
		for (const [value, expected] of [
			[new Error("failure"), "failure"],
			["failure", "failure"],
			[42, "42"],
			[undefined, "undefined"],
			[null, "null"],
			[{}, "[object Object]"],
		] as const)
			expect(formatThrownValue(value)).toBe(expected);
	});
	it("uses the safe serializer when conversion is unavailable", () => {
		expect(formatThrownValue(Object.create(null))).toBe("{}");
		expect(formatThrownValue({ toString: 0 })).toBe('{"toString":0}');
		const cyclic = Object.create(null) as Record<string, unknown>;
		cyclic.self = cyclic;
		expect(formatThrownValue(cyclic)).toBe("Unserializable thrown value");
	});
	it("contains failures from inspecting an opaque thrown value", () => {
		const value = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("opaque prototype");
				},
				get() {
					throw new Error("opaque property");
				},
			},
		);
		expect(formatThrownValue(value)).toBe("Unserializable thrown value");
	});
});
