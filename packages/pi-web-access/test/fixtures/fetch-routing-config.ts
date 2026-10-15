// Import before extract.ts: it resolves the web-search.json path when it loads.
// Allows loopback fetches and lists "http" after another (unconfigured) provider.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fetchRoutingConfigDir = mkdtempSync(join(tmpdir(), "pie-fetch-routing-"));
writeFileSync(
	join(fetchRoutingConfigDir, "web-search.json"),
	JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] }, fetchRouting: { providers: ["firecrawl", "http"] } }),
);
process.env.PIE_CODING_AGENT_DIR = fetchRoutingConfigDir;
