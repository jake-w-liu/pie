import type { AuthPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("interactive auth secret prompts", () => {
	it("routes secret prompts to masked dialog input", async () => {
		const dialog = {
			showPrompt: vi.fn(async () => "secret-value"),
		} as unknown as LoginDialogComponent;
		const prompt: AuthPrompt = { type: "secret", message: "Enter secret", placeholder: "token" };
		const showAuthPrompt = Reflect.get(InteractiveMode.prototype, "showAuthPrompt") as (
			this: object,
			dialog: LoginDialogComponent,
			prompt: AuthPrompt,
		) => Promise<string>;

		await expect(showAuthPrompt.call({}, dialog, prompt)).resolves.toBe("secret-value");
		expect(dialog.showPrompt).toHaveBeenCalledWith("Enter secret", "token", true);
	});
});
