import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Pie retains the upstream npm name (@earendil-works/pi-coding-agent) but restarts
// versioning at 0.1.0 while including the upstream trust-gating fix
// (project_trust event, trust.json, defaultProjectTrust; see
// packages/coding-agent/docs/security.md). npm audit matches advisories purely on
// the version range, so registry advisories against the upstream package name can
// flag the local workspace even though the fix is present. Those findings are
// acknowledged here after verifying them against the cited source; every other
// moderate+ finding still fails the audit.
const ALLOWLIST = [
	{
		name: "@earendil-works/pi-coding-agent",
		url: "https://github.com/advisories/GHSA-mqxh-6gq7-558m",
		reason:
			"Upstream <0.79.0 project-local extension trust issue; Pie 0.1.0 includes the trust gating fix, version match is semver-only.",
	},
];

const SEVERITY_ORDER = new Map([
	["info", 0],
	["low", 1],
	["moderate", 2],
	["high", 3],
	["critical", 4],
]);

function advisoryUrls(vulnerability) {
	const urls = [];
	for (const entry of vulnerability?.via ?? []) {
		if (entry && typeof entry === "object" && typeof entry.url === "string") {
			urls.push(entry.url);
		}
	}
	return urls;
}

export function filterAuditReport(report, allowlist = ALLOWLIST, minimumSeverity = "moderate") {
	const threshold = SEVERITY_ORDER.get(minimumSeverity) ?? 2;
	const vulnerabilities = report?.vulnerabilities ?? {};
	const blocking = [];
	const acknowledged = [];

	for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
		const severity = vulnerability?.severity ?? "info";
		if ((SEVERITY_ORDER.get(severity) ?? 0) < threshold) {
			continue;
		}
		const urls = advisoryUrls(vulnerability);
		const unacknowledged = urls.filter(
			(url) => !allowlist.some((entry) => entry.name === name && entry.url === url),
		);
		// Findings without advisory URLs (plain dependency chains) can never be
		// allowlisted; treat them as blocking.
		if (urls.length === 0 || unacknowledged.length > 0) {
			blocking.push({ name, severity, urls: unacknowledged.length > 0 ? unacknowledged : urls });
		} else {
			acknowledged.push({ name, severity, urls });
		}
	}

	return { blocking, acknowledged };
}

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function runNpmAuditJson() {
	const result = spawnSync(npmCommand(), ["audit", "--omit=dev", "--json"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ""}`.trim();
	if (!output) {
		throw new Error(`npm audit produced no output${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	}
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`npm audit produced invalid JSON: ${output.slice(0, 500)}`);
	}
}

export function main() {
	let report;
	try {
		report = runNpmAuditJson();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
	const { blocking, acknowledged } = filterAuditReport(report);
	for (const item of acknowledged) {
		console.log(`Acknowledged ${item.severity} ${item.name}: ${item.urls.join(", ")}`);
	}
	if (blocking.length === 0) {
		console.log("npm audit: no blocking production vulnerabilities (moderate+).");
		return;
	}
	console.error("npm audit found blocking production vulnerabilities:");
	for (const item of blocking) {
		console.error(`  ${item.severity} ${item.name}: ${item.urls.join(", ") || "(no advisory URL)"}`);
	}
	console.error('If a finding is a version-only match against this fork, verify the source then add it to ALLOWLIST in scripts/npm-audit.mjs.');
	process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
