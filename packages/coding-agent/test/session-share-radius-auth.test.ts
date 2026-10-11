import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ShareContext = Parameters<typeof shareSession>[0];

describe("shareSession Radius authentication", () => {
	it("reports an authentication failure without rejecting", async () => {
		initTheme("dark");
		const errors: string[] = [];
		const session = {
			sessionManager: {
				getSessionId: () => "session-id",
				getCwd: () => process.cwd(),
				getBranch: () => [],
			},
			state: { systemPrompt: "system", tools: [] },
			modelRuntime: {
				getProvider: () => ({}),
				getAuth: vi.fn().mockRejectedValue(new Error("OAuth refresh failed for radius")),
			},
		} as unknown as AgentSession;
		const context: ShareContext = {
			session,
			ui: {} as never,
			editorContainer: {} as never,
			editor: {} as never,
			showStatus: () => {},
			showError: (message) => errors.push(message),
		};

		await expect(shareSession(context)).resolves.toBeUndefined();
		expect(errors).toEqual(["Failed to authenticate with Radius: OAuth refresh failed for radius"]);
	});
});
