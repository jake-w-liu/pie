/**
 * Regression tests: an agent definition may only narrow the global permission
 * policy, never widen it.
 *
 * `resolveNearestProjectAgentDirs` loads agents from `<projectRoot>/.agents` and
 * `<projectRoot>/.pi/agents`, so a checked-out repository can supply an agent
 * file. When agent rules were spread last and "allow" entries were then dropped
 * (absence means allow), a repo-supplied agent's `"allow"` silently nullified the
 * user's global `deny`/`ask`. Most restrictive must win instead.
 */
import { describe, expect, it } from "vitest";
import {
	type PermissionConfig,
	permissionDecision,
	resolvePermissionRules,
} from "../src/runs/shared/permissions.ts";

function global(rules: PermissionConfig["rules"]): PermissionConfig {
	return { rules };
}

describe("resolvePermissionRules", () => {
	it("does not let an agent allow override a global deny", () => {
		const rules = resolvePermissionRules(global({ read: "deny" }), { read: "allow" });

		expect(rules).toEqual({ read: "deny" });
		expect(permissionDecision(rules, "read")).toBe("deny");
	});

	it("does not let an agent allow override a global ask", () => {
		const rules = resolvePermissionRules(global({ edit: "ask" }), { edit: "allow" });

		expect(permissionDecision(rules, "edit")).toBe("ask");
	});

	it("lets an agent tighten allow to ask and ask to deny", () => {
		expect(resolvePermissionRules(global({ edit: "allow" }), { edit: "ask" })).toEqual({ edit: "ask" });
		expect(resolvePermissionRules(global({ edit: "ask" }), { edit: "deny" })).toEqual({ edit: "deny" });
	});

	it("lets an agent restrict a tool the global policy does not mention", () => {
		expect(resolvePermissionRules(undefined, { read: "deny" })).toEqual({ read: "deny" });
	});

	it("keeps the most restrictive decision when both sides specify one", () => {
		const rules = resolvePermissionRules(global({ read: "deny", write: "deny", edit: "ask" }), {
			read: "allow",
			write: "allow",
			edit: "allow",
		});

		expect(permissionDecision(rules, "read")).toBe("deny");
		expect(permissionDecision(rules, "write")).toBe("deny");
		expect(permissionDecision(rules, "edit")).toBe("ask");
	});

	it("omits tools left unrestricted so absence keeps meaning allow", () => {
		expect(resolvePermissionRules(undefined, { read: "allow" })).toBeUndefined();
		expect(resolvePermissionRules(global({ read: "allow" }), undefined)).toBeUndefined();
		expect(resolvePermissionRules(undefined, undefined)).toBeUndefined();
	});

	it("leaves the global policy untouched when no agent rules apply", () => {
		expect(resolvePermissionRules(global({ read: "deny", edit: "ask" }), undefined)).toEqual({
			read: "deny",
			edit: "ask",
		});
	});
});
