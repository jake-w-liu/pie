import assert from "node:assert/strict";
import test from "node:test";
import { filterAuditReport } from "./npm-audit.mjs";

const ADVISORY_URL = "https://github.com/advisories/GHSA-mqxh-6gq7-558m";

function forkFalsePositiveReport() {
	return {
		vulnerabilities: {
			"@earendil-works/pi-coding-agent": {
				name: "@earendil-works/pi-coding-agent",
				severity: "moderate",
				via: [
					{
						name: "@earendil-works/pi-coding-agent",
						severity: "moderate",
						title: "Pi Agent: Pi loads project-local extensions without approval",
						url: ADVISORY_URL,
						range: "<0.79.0",
					},
				],
				range: "<0.79.0",
				nodes: ["node_modules/@earendil-works/pi-coding-agent", "packages/coding-agent"],
				fixAvailable: false,
			},
		},
	};
}

test("acknowledges the fork version-only match so the scheduled audit passes", () => {
	const { blocking, acknowledged } = filterAuditReport(forkFalsePositiveReport());
	assert.equal(blocking.length, 0);
	assert.equal(acknowledged.length, 1);
	assert.equal(acknowledged[0].name, "@earendil-works/pi-coding-agent");
});

test("still blocks real moderate+ vulnerabilities", () => {
	const report = forkFalsePositiveReport();
	report.vulnerabilities.undici = {
		name: "undici",
		severity: "high",
		via: [
			{
				name: "undici",
				severity: "high",
				title: "undici example",
				url: "https://github.com/advisories/GHSA-example",
				range: "<8.10.0",
			},
		],
		nodes: ["node_modules/undici"],
		fixAvailable: true,
	};
	const { blocking } = filterAuditReport(report);
	assert.equal(blocking.length, 1);
	assert.equal(blocking[0].name, "undici");
});

test("still blocks an unlisted advisory for the same workspace package", () => {
	const report = forkFalsePositiveReport();
	report.vulnerabilities["@earendil-works/pi-coding-agent"].via.push({
		name: "@earendil-works/pi-coding-agent",
		severity: "high",
		title: "hypothetical future issue",
		url: "https://github.com/advisories/GHSA-future",
		range: "<99.0.0",
	});
	const { blocking } = filterAuditReport(report);
	assert.equal(blocking.length, 1);
	assert.deepEqual(blocking[0].urls, ["https://github.com/advisories/GHSA-future"]);
});

test("ignores low severity findings below the moderate threshold", () => {
	const { blocking, acknowledged } = filterAuditReport({
		vulnerabilities: {
			foo: { name: "foo", severity: "low", via: ["foo"], nodes: ["node_modules/foo"] },
		},
	});
	assert.equal(blocking.length, 0);
	assert.equal(acknowledged.length, 0);
});
