import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

describe("ModelConfig", () => {
	it.each([
		["contextWindow", 0],
		["contextWindow", -1],
		["maxTokens", 0],
		["maxTokens", -1],
	] as const)("rejects a nonpositive %s override", async (field, value) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-model-config-"));
		try {
			const path = join(dir, "models.json");
			writeFileSync(
				path,
				JSON.stringify({ providers: { openai: { modelOverrides: { model: { [field]: value } } } } }),
			);

			const config = await ModelConfig.load(path);

			expect(config.getError()).toContain(`modelOverrides.model.${field}`);
			expect(config.getProvider("openai")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
