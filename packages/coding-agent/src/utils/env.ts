/**
 * Shared environment-flag helpers. Several subsystems gate network access on
 * `PI_OFFLINE`; they must agree on what counts as offline, otherwise one
 * layer goes offline while another stays online for values like `PI_OFFLINE=0`.
 */

/** True for "1", "true", or "yes" (case-insensitive). Everything else (including "0") counts as unset. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** True when offline mode is explicitly enabled via `PI_OFFLINE`. */
export function isOfflineModeEnabled(): boolean {
	return isTruthyEnvFlag(process.env.PI_OFFLINE);
}
