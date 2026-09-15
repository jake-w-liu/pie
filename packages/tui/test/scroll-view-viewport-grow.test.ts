import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { renderLayoutFrame } from "../src/layout.ts";

describe("ScrollView viewport-grow clamp (A1)", () => {
	it("clamps scrollTop to maxScrollTop when the viewport grows", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6\n7\n8", 0, 0), {
			follow: "none",
			primary: true,
		});
		const noop = () => {};
		// Content 8 rows, viewport 3 rows -> maxScrollTop 5.
		scrollView.updateLayout(8, 3, noop);
		scrollView.scrollTo(5);
		assert.strictEqual(scrollView.scrollTop, 5);
		// Viewport grows 3 -> 6 while content is unchanged. New maxScrollTop is 2;
		// a stale scrollTop of 5 would render blank rows past the end of content.
		scrollView.updateLayout(8, 6, noop);
		assert.strictEqual(scrollView.scrollTop, 2);
	});

	it("renders no blank rows past content after a viewport grow", () => {
		const text = new Text("1\n2\n3\n4\n5\n6\n7\n8", 0, 0);
		const scrollView = new ScrollView(text, { follow: "none", primary: true });
		renderLayoutFrame(scrollView, 10, 3, () => {});
		scrollView.scrollTo(5);
		assert.strictEqual(scrollView.scrollTop, 5);
		const frame = renderLayoutFrame(scrollView, 10, 6, () => {});
		assert.strictEqual(scrollView.scrollTop, 2);
		// The viewport shows 6 rows of real content (rows 3-8), no trailing blanks.
		const visible = frame.lines.map((line) => line.trim());
		assert.deepStrictEqual(visible, ["3", "4", "5", "6", "7", "8"]);
	});

	it("still preserves position when the grown viewport stays within budget", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6\n7\n8", 0, 0), {
			follow: "none",
			primary: true,
		});
		const noop = () => {};
		scrollView.updateLayout(8, 3, noop);
		scrollView.scrollTo(1);
		scrollView.updateLayout(8, 4, noop);
		// maxScrollTop is 4; scrollTop 1 remains valid and must not jump.
		assert.strictEqual(scrollView.scrollTop, 1);
	});
});
