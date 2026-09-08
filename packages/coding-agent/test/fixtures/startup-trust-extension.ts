import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	pi.on("project_trust", (event) => {
		const log = process.env.TEST_TRUST_LOG;
		if (!log) throw new Error("TEST_TRUST_LOG required");
		appendFileSync(log, `${event.cwd}\n`);
		return { trusted: "yes" };
	});
}
