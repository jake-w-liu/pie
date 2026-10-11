import { describe, expect, it } from "vitest";
import {
	claimWorkflowChildPermit,
	consumeWorkflowChildPermit,
	createWorkflowChildPermit,
	type WorkflowChildPermitLaunch,
} from "../src/shared/workflow-child-permit.ts";
import { stableJsonDigest } from "../src/shared/launch-contract.ts";

/**
 * A delegated workflow permit covers one child. The setup-abort retry is
 * host-initiated and only fires for a child that produced no usage, so the
 * permit grants it exactly once: the recovery path has to work, and the bound
 * that stops a delegated workflow from spawning unbounded children has to hold.
 */
describe("workflow child permit auto-resume bound", () => {
	function makePermit() {
		const launchContractDigest = stableJsonDigest({ definitionDigest: "agent", task: "A" });
		const permit = createWorkflowChildPermit({
			issuerPackage: "test",
			workflowRunId: "wf",
			childKey: "a",
			agent: "w",
			launchContractDigest,
			context: "fresh",
		});
		const launch = (overrides: Partial<WorkflowChildPermitLaunch> = {}): WorkflowChildPermitLaunch => ({
			workflowRunId: "wf",
			childKey: "a",
			agent: "w",
			launchContractDigest,
			context: "fresh",
			runner: "pi",
			...overrides,
		});
		return { permit, launch };
	}

	it("allows the first launch and one setup-abort retry, then refuses", () => {
		const { permit, launch } = makePermit();

		expect(claimWorkflowChildPermit(permit, "wf", "a")).toBeUndefined();
		expect(consumeWorkflowChildPermit(permit, launch())).toBeUndefined();
		// The host-initiated setup-abort retry for the same child.
		expect(consumeWorkflowChildPermit(permit, launch())).toBeUndefined();
		// A third launch is a real second spawn, not a recovery.
		expect(consumeWorkflowChildPermit(permit, launch())).toBe("Workflow child permit is already consumed.");
	});

	it("refuses the retry when it targets a different child", () => {
		const { permit, launch } = makePermit();

		claimWorkflowChildPermit(permit, "wf", "a");
		expect(consumeWorkflowChildPermit(permit, launch())).toBeUndefined();
		expect(consumeWorkflowChildPermit(permit, launch({ childKey: "b" }))).toBe(
			"Workflow child permit child key mismatch.",
		);
	});

	it("still refuses a retry whose launch projection does not match", () => {
		const { permit, launch } = makePermit();

		claimWorkflowChildPermit(permit, "wf", "a");
		expect(consumeWorkflowChildPermit(permit, launch())).toBeUndefined();
		expect(consumeWorkflowChildPermit(permit, launch({ context: "fork" }))).toBe(
			"Workflow child permit does not match the final launch projection.",
		);
		// The refused attempt did not consume the bounded allowance.
		expect(consumeWorkflowChildPermit(permit, launch())).toBeUndefined();
	});
});