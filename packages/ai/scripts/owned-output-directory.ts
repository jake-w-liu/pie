import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_CATALOG_OUTPUT_MARKER = ".pi-model-catalog-output";
const MARKER_CONTENT = "created by packages/ai/scripts/generate-models.ts\n";

export function markModelCatalogOutput(directory: string): void {
	writeFileSync(join(directory, MODEL_CATALOG_OUTPUT_MARKER), MARKER_CONTENT);
}

export function replaceModelCatalogOutput(target: string, staged: string, force: boolean): void {
	if (existsSync(target)) {
		const marker = join(target, MODEL_CATALOG_OUTPUT_MARKER);
		if (!force && (!existsSync(marker) || readFileSync(marker, "utf8") !== MARKER_CONTENT)) {
			throw new Error(`Refusing to replace unowned JSON output directory: ${target} (pass --force-json-output to replace it)`);
		}
		rmSync(target, { recursive: true, force: true });
	}
	renameSync(staged, target);
}
