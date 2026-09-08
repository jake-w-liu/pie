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

	it.each(["append", "remove", "replace"])("retains unchanged pending slots when siblings %s", async (change) => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const requests: Array<{ source: string; resolve: (value: { data: string; mimeType: string } | null) => void }> =
			[];
		mocks.convertToPng.mockImplementation(
			(source: string) => new Promise((resolve) => requests.push({ source, resolve })),
		);
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const component = new ToolExecutionComponent("custom", "call", {}, {}, undefined, ui, process.cwd());
		const image = (data: string) => ({ type: "image", data, mimeType: "image/jpeg" });
		component.updateResult(
			{ content: change === "append" ? [image("A")] : [image("A"), image("B")], isError: false },
			true,
		);
		const content =
			change === "append" ? [image("A"), image("B")] : change === "remove" ? [image("A")] : [image("A"), image("C")];
		component.updateResult({ content, isError: false }, true);
		expect(requests.filter((request) => request.source === "A")).toHaveLength(1);
		requests[0]!.resolve({ data: "A-png", mimeType: "image/png" });
		await Promise.resolve();
		const conversions = Reflect.get(component, "convertedImages") as Map<
			number,
			{ sourceData: string; data: string }
		>;
		expect(conversions.get(0)).toMatchObject({ sourceData: "A", data: "A-png" });
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
		component.updateResult({ content, isError: false });
		expect(requests.filter((request) => request.source === "A")).toHaveLength(1);
		for (const request of requests.slice(1))
			request.resolve({ data: `${request.source}-png`, mimeType: "image/png" });
		await Promise.resolve();
		expect(conversions.get(1)?.sourceData).toBe(change === "remove" ? undefined : change === "append" ? "B" : "C");
	});

	it("rejects stale ABA completions without deleting the replacement request", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const resolves: Array<(value: { data: string; mimeType: string }) => void> = [];
		mocks.convertToPng.mockImplementation(() => new Promise((resolve) => resolves.push(resolve)));
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const component = new ToolExecutionComponent("custom", "call", {}, {}, undefined, ui, process.cwd());
		const update = (data: string) =>
			component.updateResult({ content: [{ type: "image", data, mimeType: "image/jpeg" }], isError: false }, true);
		update("A");
		update("B");
		update("A");
		resolves[0]!({ data: "stale-A", mimeType: "image/png" });
		await Promise.resolve();
		expect(ui.requestRender).not.toHaveBeenCalled();
		update("A");
		expect(mocks.convertToPng).toHaveBeenCalledTimes(3);
		resolves[2]!({ data: "current-A", mimeType: "image/png" });
		await Promise.resolve();
		resolves[1]!({ data: "stale-B", mimeType: "image/png" });
		await Promise.resolve();
		const conversions = Reflect.get(component, "convertedImages") as Map<number, { data: string }>;
		expect(conversions.get(0)?.data).toBe("current-A");
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("retries a null conversion on a later result update", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		mocks.convertToPng.mockResolvedValueOnce(null).mockResolvedValueOnce({ data: "png", mimeType: "image/png" });
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const component = new ToolExecutionComponent("custom", "call", {}, {}, undefined, ui, process.cwd());
		const result = { content: [{ type: "image", data: "A", mimeType: "image/jpeg" }], isError: false };
		component.updateResult(result, true);
		await Promise.resolve();
		expect(ui.requestRender).not.toHaveBeenCalled();
		component.updateResult(result);
		await Promise.resolve();
		expect(mocks.convertToPng).toHaveBeenCalledTimes(2);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
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
