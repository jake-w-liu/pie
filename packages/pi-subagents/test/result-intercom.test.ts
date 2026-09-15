import { describe, expect, it } from "vitest";
import { buildSubagentResultIntercomPayload, resolveSubagentResultStatus } from "../src/intercom/result-intercom.ts";

describe("B12: explicit failure is not masked by process signals", () => {
	it("reports failed for success:false with an unexplained signal", () => {
		expect(
			resolveSubagentResultStatus({ success: false, exitCode: 1, processSignal: "SIGKILL" }),
		).toBe("failed");
	});

	it("still reports stopped for an unexplained signal without a verdict", () => {
		expect(
			resolveSubagentResultStatus({ exitCode: 1, processSignal: "SIGKILL" }),
		).toBe("stopped");
	});

	it("still reports completed for success:true even with a signal", () => {
		expect(
			resolveSubagentResultStatus({ success: true, exitCode: 1, processSignal: "SIGKILL" }),
		).toBe("completed");
	});
});

describe("B12: grouped status surfaces live-detached children", () => {
	function payload(statuses: Array<"completed" | "detached" | "failed">) {
		return buildSubagentResultIntercomPayload({
			to: "parent",
			runId: "run-1",
			mode: "parallel",
			source: "foreground",
			children: statuses.map((status, index) => ({
				agent: `agent-${index}`,
				status,
				summary: "output",
			})),
		});
	}

	it("groups [completed, detached] as detached, not completed", () => {
		expect(payload(["completed", "detached"]).status).toBe("detached");
	});

	it("still groups failed above detached", () => {
		expect(payload(["detached", "failed"]).status).toBe("failed");
	});

	it("groups all-completed as completed", () => {
		expect(payload(["completed", "completed"]).status).toBe("completed");
	});
});
