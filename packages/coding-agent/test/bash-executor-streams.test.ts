import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashExecutionMessage, bashExecutionToText } from "../src/core/messages.ts";
import { type BashOperations, createLocalBashOperations } from "../src/core/tools/bash.ts";

function toMessage(
	command: string,
	result: Awaited<ReturnType<typeof executeBashWithOperations>>,
): BashExecutionMessage {
	return { role: "bashExecution", command, timestamp: 1, ...result };
}

describe("bash execution stream handling", () => {
	it("decodes independently chunked stdout and stderr without corrupting UTF-8", async () => {
		const check = Buffer.from("✓");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(check.subarray(0, 1), "stdout");
				onData(Buffer.from("ERR"), "stderr");
				onData(check.subarray(1), "stdout");
				return { exitCode: 0 };
			},
		};

		const result = await executeBashWithOperations("test", process.cwd(), operations);
		expect(result.output).toBe("ERR✓");
		expect(result.output).not.toContain("�");
	});

	it("renders a non-cancelled missing exit code as abnormal termination", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "signal",
			output: "partial",
			exitCode: undefined,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		expect(text).toContain("Command terminated abnormally");
	});

	it.skipIf(process.platform === "win32")(
		"reports a self-signalled local command as abnormal termination",
		async () => {
			const command = "echo partial; kill -SEGV $$";
			const result = await executeBashWithOperations(command, process.cwd(), createLocalBashOperations());
			expect(result).toMatchObject({ exitCode: undefined, cancelled: false });
			expect(bashExecutionToText(toMessage(command, result))).toContain("Command terminated abnormally");
		},
	);
});
