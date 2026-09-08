import { afterEach, expect, it } from "vitest";
import { getActiveGoogleEmail, setGeminiFetchOverrideForTests } from "../../pi-web-access/gemini-web.ts";

const email = "fixture@example.com";
const cookies = { "__Secure-1PSID": "fixture" };

afterEach(() => setGeminiFetchOverrideForTests(null));

it.each(["same-origin", "cross-origin", "exhausted"])(
	"cancels unread %s Google redirect bodies without sending cookies to another origin",
	async (mode) => {
		let canceled = 0;
		let appCalls = 0;
		const urls: string[] = [];
		setGeminiFetchOverrideForTests(async (input) => {
			const url = String(input);
			urls.push(url);
			if (url.startsWith("https://accounts.google.com/")) return new Response(JSON.stringify([email]));
			appCalls++;
			if (mode === "same-origin" && appCalls === 2) return new Response(`{"oPEP7c":"${email}"}`);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("unread redirect"));
					},
					cancel() {
						canceled++;
					},
				}),
				{
					status: 302,
					headers: { location: mode === "cross-origin" ? "https://untrusted.invalid/" : "/app?redirect=1" },
				},
			);
		});

		expect(await getActiveGoogleEmail(cookies)).toBe(email);
		expect(canceled).toBe(mode === "exhausted" ? 11 : 1);
		expect(
			urls.every(
				(url) =>
					new URL(url).origin === "https://gemini.google.com" ||
					new URL(url).origin === "https://accounts.google.com",
			),
		).toBe(true);
		expect(urls.some((url) => url.includes("untrusted.invalid"))).toBe(false);
	},
);
