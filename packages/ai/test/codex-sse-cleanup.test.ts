import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "offline",
	name: "offline",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const payload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }),
).toString("base64url");
const apiKey = `offline.${payload}.offline`;

describe("Codex SSE ownership", () => {
	it.each(["caller", "timeout"] as const)(
		"keeps cancellation connected while a non-2xx body stalls (%s)",
		async (mode) => {
			const caller = new AbortController();
			let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
			const request: { signal?: AbortSignal } = {};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller;
				},
			});
			const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
				request.signal = init?.signal ?? undefined;
				request.signal?.addEventListener(
					"abort",
					() => bodyController?.error(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
				return new Response(body, { status: 401 });
			});
			const output = stream(
				model,
				{ messages: [] },
				{
					apiKey,
					transport: "sse",
					fetch,
					signal: caller.signal,
					timeoutMs: mode === "timeout" ? 50 : 1000,
				},
			);
			await setImmediate();
			if (mode === "caller") caller.abort();
			const result = await output.result();
			expect(request.signal?.aborted).toBe(true);
			expect(result.stopReason).toBe(mode === "caller" ? "aborted" : "error");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
			const events = [];
			for await (const event of output) events.push(event.type);
			expect(events).toEqual(["error"]);
		},
	);
	it.each(["observer", "parser", "missing-body", "success", "abort", "headers"] as const)(
		"releases caller abort listeners after %s settlement",
		async (mode) => {
			const controller = new AbortController();
			for (let index = 0; index < 3; index++) {
				const cancel = vi.fn();
				const body = new ReadableStream<Uint8Array>({
					start(source) {
						if (mode === "abort") return;
						source.enqueue(
							new TextEncoder().encode(
								mode === "parser"
									? "data: {broken}\n\n"
									: `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
							),
						);
					},
					cancel,
				});
				const requestController = mode === "abort" ? new AbortController() : controller;
				const fetch = vi.fn(async () => {
					if (mode === "headers") throw new Error("headers failed");
					return new Response(mode === "missing-body" ? null : body);
				});
				const output = stream(
					model,
					{ messages: [] },
					{
						apiKey,
						transport: "sse",
						signal: requestController.signal,
						timeoutMs: 1000,
						fetch,
						onResponse: () => {
							if (mode === "observer") throw new Error("observer failed");
						},
					},
				);
				if (mode === "abort") {
					await setImmediate();
					requestController.abort();
				}
				const result = await output.result();
				await setImmediate();
				expect(result.stopReason).toBe(mode === "success" ? "stop" : mode === "abort" ? "aborted" : "error");
				if (mode === "observer") expect(result.errorMessage).toBe("observer failed");
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(getEventListeners(requestController.signal, "abort")).toHaveLength(0);
				if (mode !== "missing-body" && mode !== "headers") {
					expect(cancel).toHaveBeenCalledTimes(1);
					expect(body.locked).toBe(false);
				} else {
					await body.cancel();
				}
			}
		},
	);
});
