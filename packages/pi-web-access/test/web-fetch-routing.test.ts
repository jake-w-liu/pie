// The config fixture must load first; see its header.
import { fetchRoutingConfigDir } from "./fixtures/fetch-routing-config.ts";
import { rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { extractContent } from "../extract.ts";

afterAll(() => {
	rmSync(fetchRoutingConfigDir, { recursive: true, force: true });
});

describe("fetch provider routing", () => {
	it("requests a remote URL once when the HTTP gate already failed recoverably", async () => {
		let requests = 0;
		const server = http.createServer((_request, response) => {
			requests++;
			response.writeHead(503, { "content-type": "text/plain" });
			response.end("unavailable");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as AddressInfo;
			const result = await extractContent(`http://127.0.0.1:${port}/page`);
			expect(result.error).toContain("HTTP 503");
			expect(requests).toBe(1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
