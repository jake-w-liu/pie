/**
 * Whether a tool call blocks its child until the parent answers: a contact_supervisor decision or
 * interview (not a fire-and-forget progress update), or an intercom ask.
 */
export function isBlockingSupervisorTool(toolName: string | undefined, args: unknown): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	if (toolName === "contact_supervisor") {
		const reason = (args as Record<string, unknown>).reason;
		return reason === "need_decision" || reason === "interview_request";
	}
	return toolName === "intercom" && (args as Record<string, unknown>).action === "ask";
}
