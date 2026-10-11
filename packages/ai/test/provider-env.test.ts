import { afterEach, describe, expect, it } from "vitest";
import { getProviderEnvValue } from "../src/utils/provider-env.ts";

const originalValue = process.env.PI_AI_PROVIDER_ENV_TEST;

afterEach(() => {
	if (originalValue === undefined) {
		delete process.env.PI_AI_PROVIDER_ENV_TEST;
	} else {
		process.env.PI_AI_PROVIDER_ENV_TEST = originalValue;
	}
});

describe("provider environment resolution", () => {
	it("lets an explicit empty scoped value suppress the ambient value", () => {
		process.env.PI_AI_PROVIDER_ENV_TEST = "ambient-secret";

		expect(getProviderEnvValue("PI_AI_PROVIDER_ENV_TEST", { PI_AI_PROVIDER_ENV_TEST: "" })).toBe("");
	});
});
