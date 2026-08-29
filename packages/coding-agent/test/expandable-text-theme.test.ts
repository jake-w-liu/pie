import { describe, expect, it } from "vitest";
import { ExpandableText } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("ExpandableText theme invalidation", () => {
	it("recomputes lazily styled text after a theme switch", () => {
		initTheme("pie-nippon-dark");
		const component = new ExpandableText(
			() => theme.fg("accent", "collapsed"),
			() => theme.fg("accent", "expanded"),
			false,
		);
		const dark = component.render(40).join("\n");

		initTheme("pie-nippon-light");
		component.invalidate();
		const light = component.render(40).join("\n");

		expect(light).not.toBe(dark);
		expect(light).toContain(theme.fg("accent", "collapsed"));
	});
});
