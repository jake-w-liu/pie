import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import askUserExtension, { ASK_USER_OWN_ANSWER, type AskUserDetails } from "../src/extensions/ask-user/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

type AskUserTool = {
	name: string;
	executionMode?: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ text: string }>; details: AskUserDetails }>;
};

function registerTool(): AskUserTool | undefined {
	let registered: AskUserTool | undefined;
	askUserExtension({
		registerTool: (tool: AskUserTool) => {
			registered = tool;
		},
	} as unknown as ExtensionAPI);
	return registered;
}

function context(ui: { select?: unknown; input?: unknown } | undefined): ExtensionContext {
	return { hasUI: ui !== undefined, ui } as unknown as ExtensionContext;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("ask_user tool", () => {
	it("is a built-in and runs one dialog at a time", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toContain("ask-user");
		expect(registerTool()?.executionMode).toBe("sequential");
	});

	it("is not registered in subagent child processes, which ask their supervisor instead", () => {
		vi.stubEnv("PI_SUBAGENT_CHILD", "1");
		expect(registerTool()).toBeUndefined();
	});

	it("returns the option the user picks", async () => {
		const select = vi.fn(async (_title: string, choices: string[]) => choices[1]);
		const result = await registerTool()!.execute(
			"call",
			{
				question: "Which database?",
				options: [{ label: "SQLite", description: "embedded" }, { label: "Postgres" }],
			},
			undefined,
			undefined,
			context({ select }),
		);
		expect(select).toHaveBeenCalledWith(
			"Which database?",
			["SQLite — embedded", "Postgres", ASK_USER_OWN_ANSWER],
			expect.objectContaining({}),
		);
		expect(result.content[0]!.text).toBe("User answered: Postgres");
		expect(result.details).toMatchObject({ answer: "Postgres", custom: false });
	});

	it("lets the user type their own answer instead of an option", async () => {
		const result = await registerTool()!.execute(
			"call",
			{ question: "Which database?", options: [{ label: "SQLite" }] },
			undefined,
			undefined,
			context({ select: async () => ASK_USER_OWN_ANSWER, input: async () => "  DuckDB " }),
		);
		expect(result.details).toMatchObject({ answer: "DuckDB", custom: true });
	});

	it("asks for free text when there are no options, and offers no own-answer choice when disallowed", async () => {
		const free = await registerTool()!.execute(
			"call",
			{ question: "Project name?" },
			undefined,
			undefined,
			context({ input: async () => "pie" }),
		);
		expect(free.content[0]!.text).toBe("User answered: pie");

		const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
		await registerTool()!.execute(
			"call",
			{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }], allowFreeText: false },
			undefined,
			undefined,
			context({ select }),
		);
		expect(select.mock.calls[0]![1]).toEqual(["Yes", "No"]);
	});

	it("reports a dismissed question without inventing an answer", async () => {
		const result = await registerTool()!.execute(
			"call",
			{ question: "Which database?", options: [{ label: "SQLite" }] },
			undefined,
			undefined,
			context({ select: async () => undefined }),
		);
		expect(result.details).toMatchObject({ answer: null, unanswered: "dismissed" });
		expect(result.content[0]!.text).toContain("Do not assume an answer");
	});

	it("tells the agent to proceed on an assumption when no user can answer", async () => {
		const result = await registerTool()!.execute(
			"call",
			{ question: "Which database?" },
			undefined,
			undefined,
			context(undefined),
		);
		expect(result.details).toMatchObject({ answer: null, unanswered: "no-ui" });
		expect(result.content[0]!.text).toContain("state the assumption");
	});

	it("dismisses the dialog and fails when the turn is aborted", async () => {
		const controller = new AbortController();
		const input = vi.fn(async (_title: string, _placeholder: string, options: { signal?: AbortSignal }) => {
			expect(options.signal).toBe(controller.signal);
			controller.abort();
			return undefined;
		});
		await expect(
			registerTool()!.execute("call", { question: "Name?" }, controller.signal, undefined, context({ input })),
		).rejects.toThrow("Operation aborted");
	});

	it("rejects options that cannot be told apart", async () => {
		const tool = registerTool()!;
		const ui = context({ select: async () => undefined });
		for (const options of [
			[{ label: "A" }, { label: "A" }],
			[{ label: " " }],
			[{ label: ASK_USER_OWN_ANSWER }],
			[{ label: "a — b" }, { label: "a", description: "b" }],
		]) {
			await expect(tool.execute("call", { question: "Pick", options }, undefined, undefined, ui)).rejects.toThrow();
		}
		await expect(
			tool.execute("call", { question: "Pick", allowFreeText: false }, undefined, undefined, ui),
		).rejects.toThrow("Provide options");
	});
});
