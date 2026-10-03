import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath , jsonParseDiagnostic } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

type FeatureConfig = { image?: { enabled?: unknown } };

function loadFeatureConfig(): FeatureConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return raw && typeof raw === "object" ? raw as FeatureConfig : {};
	} catch (err) {
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${jsonParseDiagnostic(err)}`);
	}
}

export function isImageEnabled(): boolean {
	return loadFeatureConfig().image?.enabled !== false;
}

export function canAttachImages(): boolean {
	try {
		return isImageEnabled();
	} catch {
		return false;
	}
}
