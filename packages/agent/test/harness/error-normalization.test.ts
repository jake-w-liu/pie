import { expect, it } from "vitest";
import { toError } from "../../src/harness/types.ts";

it("keeps Error identity and existing JSON diagnostics", () => {
	const original = new Error("original");
	expect(toError(original)).toBe(original);
	expect(toError("failure").message).toBe("failure");
	expect(toError({ code: "fixture" }).message).toBe('{"code":"fixture"}');
	expect(toError(undefined).message).toBe("");
});

it("normalizes cyclic and opaque failures without throwing during error handling", () => {
	const cyclic = Object.create(null) as Record<string, unknown>;
	cyclic.self = cyclic;
	const opaque = new Proxy(
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
	for (const value of [cyclic, opaque]) {
		const error = toError(value);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Unserializable thrown value");
	}
});
