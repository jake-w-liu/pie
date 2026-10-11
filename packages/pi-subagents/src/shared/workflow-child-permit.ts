import { stableJsonDigest } from "./launch-contract.ts";

export interface WorkflowChildPermitInput {
	issuerPackage: string;
	workflowRunId: string;
	childKey: string;
	agent: string;
	launchContractDigest: string;
	context: "fresh" | "fork";
}

export interface WorkflowChildPermitLaunch {
	workflowRunId: string;
	childKey: string;
	agent: string;
	launchContractDigest: string;
	context: "fresh" | "fork";
	runner: "pi";
}

export interface WorkflowChildPermitContext {
	permit: WorkflowChildPermit;
	workflowRunId: string;
	childKey: string;
}

export interface WorkflowChildPermit {
	readonly __workflowChildPermit: unique symbol;
}

interface WorkflowChildPermitRecord {
	issuerPackage: string;
	workflowRunId: string;
	childKey: string;
	agent: string;
	expectedProjectionDigest: string;
	state: "available" | "claimed" | "consumed";
	/**
	 * Setup-abort auto-resume launches granted after the first attempt consumed the
	 * permit. The retry is host-initiated (the workflow script cannot request it)
	 * and only fires for a child that produced no usage, so it is bounded to one
	 * per permit: a delegated workflow still cannot spawn unbounded children.
	 */
	resumedLaunches: number;
}

/** One host-initiated setup-abort retry per permit; nothing more. */
const MAX_AUTO_RESUME_LAUNCHES = 1;

const records = new WeakMap<object, WorkflowChildPermitRecord>();

function projectionDigest(input: Omit<WorkflowChildPermitLaunch, "workflowRunId">): string {
	return stableJsonDigest({
		version: 1,
		childKey: input.childKey,
		agent: input.agent,
		launchContractDigest: input.launchContractDigest,
		context: input.context,
		runner: input.runner,
	});
}

function required(value: string, label: string): string {
	if (!value.trim() || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string.`);
	return value;
}

/** Package-internal first-slice permit. It is opaque, in-memory, and not serializable. */
export function createWorkflowChildPermit(input: WorkflowChildPermitInput): WorkflowChildPermit {
	const permit = Object.freeze(Object.create(null)) as WorkflowChildPermit;
	const record: WorkflowChildPermitRecord = {
		issuerPackage: required(input.issuerPackage, "issuerPackage"),
		workflowRunId: required(input.workflowRunId, "workflowRunId"),
		childKey: required(input.childKey, "childKey"),
		agent: required(input.agent, "agent"),
		expectedProjectionDigest: projectionDigest({
			childKey: input.childKey,
			agent: input.agent,
			launchContractDigest: required(input.launchContractDigest, "launchContractDigest"),
			context: input.context,
			runner: "pi",
		}),
		state: "available",
		resumedLaunches: 0,
	};
	records.set(permit as object, record);
	return permit;
}

export function validateWorkflowChildPermitRoot(permit: WorkflowChildPermit, workflowRunId: string): string | undefined {
	const record = records.get(permit as object);
	if (!record) return "Workflow child permit is invalid.";
	if (record.state !== "available") return "Workflow child permit is already consumed.";
	if (record.workflowRunId !== workflowRunId) return "Workflow child permit does not match this workflow root.";
	return undefined;
}

/** Claim the first distinct launch attempt before validating its model-authored shape. */
export function claimWorkflowChildPermit(permit: WorkflowChildPermit, workflowRunId: string, childKey: string): string | undefined {
	const record = records.get(permit as object);
	if (!record) return "Workflow child permit is invalid.";
	if (record.state !== "available") return "Workflow child permit is already consumed.";
	if (record.workflowRunId !== workflowRunId) return "Workflow child permit does not match this workflow root.";
	record.state = record.childKey === childKey ? "claimed" : "consumed";
	if (record.childKey !== childKey) return "Workflow child permit child key mismatch.";
	return undefined;
}

/** Verify and permanently consume the permit before the one native process spawn. */
export function consumeWorkflowChildPermit(permit: WorkflowChildPermit, launch: WorkflowChildPermitLaunch): string | undefined {
	const record = records.get(permit as object);
	if (!record) return "Workflow child permit is invalid.";
	if (record.state === "available") return "Workflow child permit launch was not claimed.";
	const isAutoResume = record.state === "consumed";
	if (isAutoResume) {
		// The first attempt already spawned. Allow the one bounded setup-abort retry
		// for the same child, and nothing more.
		if (record.resumedLaunches >= MAX_AUTO_RESUME_LAUNCHES) return "Workflow child permit is already consumed.";
		if (record.childKey !== launch.childKey) return "Workflow child permit child key mismatch.";
	}
	// Every check runs before any state changes, so a launch that is refused for a
	// mismatched projection cannot burn the single auto-resume allowance.
	if (record.workflowRunId !== launch.workflowRunId) return "Workflow child permit does not match this workflow root.";
	if (record.childKey !== launch.childKey) return "Workflow child permit child key mismatch.";
	if (record.agent !== launch.agent) return "Workflow child permit agent mismatch.";
	if (launch.runner !== "pi") return "Workflow child permit supports native Pi children only.";
	if (record.expectedProjectionDigest !== projectionDigest(launch)) {
		return "Workflow child permit does not match the final launch projection.";
	}
	if (isAutoResume) record.resumedLaunches++;
	record.state = "consumed";
	return undefined;
}

export function workflowChildPermitConsumed(permit: WorkflowChildPermit): boolean {
	const state = records.get(permit as object)?.state;
	return state === "claimed" || state === "consumed";
}
