import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("queued image-only messages", () => {
	it.each(["steer", "followUp"] as const)("leave the pending %s queue once delivered", async (streamingBehavior) => {
		harness = await createHarness();
		const { session } = harness;
		let enterFirst!: () => void;
		const firstEntered = new Promise<void>((resolve) => {
			enterFirst = resolve;
		});
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		harness.setResponses([
			async () => {
				enterFirst();
				await firstReleased;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);

		const run = session.prompt("start");
		await firstEntered;
		await session.prompt("", {
			streamingBehavior,
			images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
			source: "rpc",
		});
		expect(session.pendingMessageCount).toBe(1);

		releaseFirst();
		await run;
		await session.waitForIdle();

		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.getSteeringMessages()).toEqual([]);
		expect(session.getFollowUpMessages()).toEqual([]);
		expect(harness.eventsOfType("queue_update").at(-1)).toEqual({ type: "queue_update", steering: [], followUp: [] });
		expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
	});
});
