import { resetCapabilitiesCache, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const mocks = vi.hoisted(() => ({ convertToPng: vi.fn() }));
vi.mock("../src/utils/image-convert.ts", () => ({ convertToPng: mocks.convertToPng }));

describe("ToolExecutionComponent image conversion", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		mocks.convertToPng.mockReset();
		resetCapabilitiesCache();
	});

	it("does not restart an in-flight conversion for unchanged partial images", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		mocks.convertToPng.mockImplementation(() => new Promise(() => {}));
		const component = new ToolExecutionComponent(
			"custom",
			"call",
			{},
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		const result = {
			content: [{ type: "image", data: "same-image", mimeType: "image/jpeg" }],
			isError: false,
		};

		component.updateResult(result, true);
		component.updateResult(result, true);

		expect(mocks.convertToPng).toHaveBeenCalledTimes(1);
	});

	it("ignores an older conversion that resolves after a replacement image", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let resolveFirst: ((value: { data: string; mimeType: string }) => void) | undefined;
		let resolveSecond: ((value: { data: string; mimeType: string }) => void) | undefined;
		mocks.convertToPng
			.mockImplementationOnce(
				() =>
					new Promise<{ data: string; mimeType: string }>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<{ data: string; mimeType: string }>((resolve) => {
						resolveSecond = resolve;
					}),
			);
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const component = new ToolExecutionComponent("custom", "call", {}, {}, undefined, ui, process.cwd());

		component.updateResult({
			content: [{ type: "image", data: "first-image", mimeType: "image/jpeg" }],
			isError: false,
		});
		component.updateResult({
			content: [{ type: "image", data: "second-image", mimeType: "image/webp" }],
			isError: false,
		});
		resolveSecond?.({ data: "second-png", mimeType: "image/png" });
		await Promise.resolve();
		resolveFirst?.({ data: "first-png", mimeType: "image/png" });
		await Promise.resolve();

		const conversions = Reflect.get(component, "convertedImages") as Map<
			number,
			{ sourceData: string; data: string }
		>;
		expect(conversions.get(0)).toMatchObject({ sourceData: "second-image", data: "second-png" });
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
