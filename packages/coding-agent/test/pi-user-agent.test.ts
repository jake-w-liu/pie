import { describe, expect, it } from "vitest";
import { getPiCatalogUserAgent, getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("getPiUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent("1.2.3");

		expect(userAgent).toBe(`pi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^pi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});

describe("getPiCatalogUserAgent", () => {
	it("identifies as Pie so pi.dev serves the current catalog", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiCatalogUserAgent("0.1.7");

		expect(userAgent).toBe(`pie/0.1.7 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).not.toMatch(/^pi\//);
	});
});
