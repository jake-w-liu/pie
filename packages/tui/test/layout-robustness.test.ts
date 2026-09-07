import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getScrollbarGeometry, renderLayoutFrame } from "../src/layout.ts";
import { stripTerminalSequences } from "../src/utils.ts";

describe("layout numeric hardening", () => {
	it("renders a default spacer for non-finite line counts", () => {
		assert.deepStrictEqual(new Spacer(Infinity).render(5), [""]);
		assert.deepStrictEqual(new Spacer(NaN).render(5), [""]);
		const spacer = new Spacer(3);
		spacer.setLines(Infinity);
		assert.deepStrictEqual(spacer.render(5), [""]);
	});

	it("clamps negative box padding instead of throwing", () => {
		const box = new Box(-1, -2);
		box.addChild(new Text("hi", 0, 0));
		assert.ok(box.render(10).length > 0);
	});

	it("falls back to auto for a non-finite stack basis", () => {
		const frame = renderLayoutFrame(new VStack([{ component: new Text("x", 0, 0), basis: NaN }]), 10, 3, () => {});
		const height = frame.root.children[0]?.rect.height ?? NaN;
		assert.ok(Number.isFinite(height), `expected finite height, got ${height}`);
	});

	it("resets scroll position when the viewport grows beyond the content", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		scrollView.scrollTo(1);
		assert.strictEqual(scrollView.scrollTop, 1);

		const frame = renderLayoutFrame(scrollView, 10, 10, () => {});
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.deepStrictEqual(frame.lines.map((line) => stripTerminalSequences(line).trimEnd()).slice(0, 5), [
			"1",
			"2",
			"3",
			"4",
			"5",
		]);
	});

	it("shows no scrollbar thumb when there is no content", () => {
		const scrollView = new ScrollView(new Text("", 0, 0), { scrollbar: "always" });
		const frame = renderLayoutFrame(scrollView, 10, 4, () => {});
		assert.strictEqual(getScrollbarGeometry(frame.root), undefined);
	});
});
