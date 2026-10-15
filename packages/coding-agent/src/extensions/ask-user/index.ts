/**
 * Ask User Extension
 *
 * Gives the agent an ask_user tool: when it needs a decision or information only the user has,
 * it asks and waits for the answer instead of ending its turn with a question. Uses the standard
 * dialog primitives, so it works in the interactive TUI and over RPC; without a UI (print and
 * JSON modes) it tells the agent to proceed on a stated assumption.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

/** Set by pi-subagents for child processes, which ask their parent with contact_supervisor instead. */
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

/** The extra choice that lets the user type an answer that is not one of the options. */
export const ASK_USER_OWN_ANSWER = "Type my own answer…";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short answer the user can pick" }),
	description: Type.Optional(Type.String({ description: "What picking this option means" })),
});

const AskUserParams = Type.Object({
	question: Type.String({ description: "The question to ask, with enough context to answer it" }),
	options: Type.Optional(
		Type.Array(OptionSchema, { description: "Choices to pick from; omit for a free-text answer" }),
	),
	allowFreeText: Type.Optional(
		Type.Boolean({ description: "With options, also let the user type their own answer (default true)" }),
	),
});

export interface AskUserDetails {
	question: string;
	options: string[];
	/** The answer, or null when the user dismissed the question or no user was available. */
	answer: string | null;
	/** True when the user typed the answer rather than picking an option. */
	custom: boolean;
	/** Why there is no answer, when answer is null. */
	unanswered?: "no-ui" | "dismissed";
}

function result(text: string, details: AskUserDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function askUserExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV]) return;

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question and wait for the answer. Use it only when you cannot proceed well without the user's decision or information; decide minor details yourself. With options, the user picks one or types their own answer.",
		promptSnippet: "Ask the user a question and wait for the answer",
		promptGuidelines: [
			"Use ask_user when a decision or fact only the user has blocks progress, instead of ending your turn with a question; keep questions specific and offer options when the choices are known.",
		],
		parameters: AskUserParams,
		// One dialog at a time: parallel calls would stack prompts the user answers out of order.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const question = params.question.trim();
			const options = params.options ?? [];
			const labels = options.map((option) => option.label.trim());
			const allowFreeText = params.allowFreeText ?? true;
			if (!question) throw new Error("question must not be empty.");
			if (labels.some((label) => label.length === 0)) throw new Error("option labels must not be empty.");
			if (new Set(labels).size !== labels.length) throw new Error("option labels must be unique.");
			if (labels.includes(ASK_USER_OWN_ANSWER)) throw new Error(`"${ASK_USER_OWN_ANSWER}" is reserved.`);
			if (labels.length === 0 && !allowFreeText) {
				throw new Error("Provide options, or allow a free-text answer.");
			}

			const base = { question, options: labels, custom: false };
			if (!ctx.hasUI) {
				return result(
					"No user is available to answer in this session (non-interactive mode). Proceed with your best judgment and state the assumption you made.",
					{ ...base, answer: null, unanswered: "no-ui" },
				);
			}

			let answer: string | undefined;
			let custom = false;
			if (labels.length > 0) {
				const choices = options.map((option, index) =>
					option.description?.trim() ? `${labels[index]} — ${option.description.trim()}` : labels[index]!,
				);
				if (allowFreeText) choices.push(ASK_USER_OWN_ANSWER);
				// The picked string maps back to its option, so the displayed choices must be unique too.
				if (new Set(choices).size !== choices.length) throw new Error("options must display differently.");
				const picked = await ctx.ui.select(question, choices, { signal });
				if (picked === ASK_USER_OWN_ANSWER) {
					custom = true;
					answer = await ctx.ui.input(question, "Your answer", { signal });
				} else if (picked !== undefined) {
					answer = labels[choices.indexOf(picked)];
				}
			} else {
				custom = true;
				answer = await ctx.ui.input(question, "Your answer", { signal });
			}
			if (signal?.aborted) throw new Error("Operation aborted");

			answer = answer?.trim();
			if (!answer) {
				return result(
					"The user dismissed the question without answering. Do not assume an answer; continue only with what does not depend on it, or explain what you need.",
					{ ...base, answer: null, unanswered: "dismissed" },
				);
			}
			return result(`User answered: ${answer}`, { ...base, answer, custom });
		},
	});
}
