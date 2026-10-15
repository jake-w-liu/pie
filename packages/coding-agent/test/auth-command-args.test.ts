import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { validateAuthCommandArgs } from "../src/cli/auth-command.ts";

/**
 * Auth commands accept only --provider and --model. Session/UI options used to be
 * parsed and then silently dropped, so `pie auth check --provider x --list-models`
 * looked like it configured something and did nothing.
 */
describe("auth command argument validation", () => {
	const unsupported: Array<[string, string[]]> = [
		["--list-models", ["--provider", "openai", "--list-models"]],
		["--offline", ["--provider", "openai", "--offline"]],
		["--verbose", ["--provider", "openai", "--verbose"]],
		["--tui-mode", ["--provider", "openai", "--tui-mode", "regular"]],
		["--use-theme", ["--provider", "openai", "--use-theme", "dark"]],
		["--no-context-files", ["--provider", "openai", "-nc"]],
		["--approve", ["--provider", "openai", "--approve"]],
	];

	for (const [name, argv] of unsupported) {
		it(`rejects ${name}`, () => {
			expect(() => validateAuthCommandArgs(parseArgs(argv), "check")).toThrow(/not supported/);
		});
	}

	it("still accepts --provider and --model", () => {
		expect(validateAuthCommandArgs(parseArgs(["--provider", "openai"]), "check")).toEqual({
			provider: "openai",
			model: undefined,
		});
		expect(validateAuthCommandArgs(parseArgs(["--model", "gpt-4o"]), "check")).toEqual({
			provider: undefined,
			model: "gpt-4o",
		});
	});
});
