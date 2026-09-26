import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Context, Usage } from "../src/types.ts";

function context(text: string): Context {
	return { messages: [{ role: "user", content: text, timestamp: 1 }] };
}

async function complete(
	core: ReturnType<typeof createFauxCore>,
	text: string,
	options: { sessionId?: string; cacheRetention?: "none" | "short" | "long" } = {},
): Promise<Usage> {
	core.appendResponses([fauxAssistantMessage("ok")]);
	const message = await core.streamSimple(core.getModel(), context(text), options).result();
	return message.usage;
}

describe("faux prompt-cache usage accounting", () => {
	it("counts a cache-write turn once instead of as uncached input plus cache write", async () => {
		const core = createFauxCore({});

		const first = await complete(core, "a fairly long first prompt", { sessionId: "session" });

		expect(first.cacheWrite).toBeGreaterThan(0);
		expect(first.input).toBe(0);
		expect(first.cacheRead).toBe(0);
		expect(first.totalTokens).toBe(first.cacheWrite + first.output);
	});

	it("counts a cache-read turn once", async () => {
		const core = createFauxCore({});

		const first = await complete(core, "a fairly long first prompt", { sessionId: "session" });
		const second = await complete(core, "a fairly long first prompt", { sessionId: "session" });

		expect(second.cacheRead).toBe(first.cacheWrite);
		expect(second.cacheWrite).toBe(0);
		expect(second.input).toBe(0);
		expect(second.totalTokens).toBe(second.cacheRead + second.output);
	});

	it("splits an extended prompt into a cache read and a cache write without uncached input", async () => {
		const core = createFauxCore({});

		const first = await complete(core, "a fairly long first prompt", { sessionId: "session" });
		const extended = await complete(core, "a fairly long first prompt plus more", { sessionId: "session" });

		expect(extended.cacheRead).toBe(first.cacheWrite);
		expect(extended.cacheWrite).toBeGreaterThan(0);
		expect(extended.input).toBe(0);
		expect(extended.totalTokens).toBe(extended.cacheRead + extended.cacheWrite + extended.output);
	});

	it("keeps the whole prompt as uncached input without a session id", async () => {
		const core = createFauxCore({});

		const usage = await complete(core, "a fairly long first prompt");

		expect(usage.input).toBeGreaterThan(0);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(usage.input + usage.output);
	});

	it("keeps the whole prompt as uncached input when cache retention is off", async () => {
		const core = createFauxCore({});

		const usage = await complete(core, "a fairly long first prompt", {
			sessionId: "session",
			cacheRetention: "none",
		});

		expect(usage.input).toBeGreaterThan(0);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(usage.input + usage.output);
	});
});
