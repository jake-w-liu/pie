import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";

describe("Box", () => {
	it("invalidates cached rows when the background function changes", () => {
		const firstBackground = (text: string) => (text === "test" ? `same:${text}` : `\x1b[41m${text}\x1b[49m`);
		const secondBackground = (text: string) => (text === "test" ? `same:${text}` : `\x1b[44m${text}\x1b[49m`);
		const box = new Box(0, 0, firstBackground);
		box.addChild(new Text("content", 0, 0));

		assert.ok(box.render(10)[0]?.includes("\x1b[41m"));
		box.setBgFn(secondBackground);
		const updated = box.render(10)[0] ?? "";

		assert.ok(updated.includes("\x1b[44m"));
		assert.ok(!updated.includes("\x1b[41m"));
	});
});
