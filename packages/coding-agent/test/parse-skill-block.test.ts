import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";

const block = (): string => `<skill name="mytool" location="skills/mytool">\nstep content\n</skill>`;

describe("parseSkillBlock", () => {
	it("parses a bare skill block with no trailing user message", () => {
		const result = parseSkillBlock(block());
		expect(result).toMatchObject({ name: "mytool", location: "skills/mytool", content: "step content" });
		expect(result?.userMessage).toBeUndefined();
	});

	it("parses a skill block followed by a single-newline user message (regression)", () => {
		const result = parseSkillBlock(`${block()}\nplease run this`);
		expect(result?.name).toBe("mytool");
		expect(result?.userMessage).toBe("please run this");
	});

	it("parses a skill block followed by a blank-line user message", () => {
		const result = parseSkillBlock(`${block()}\n\nplease run this`);
		expect(result?.userMessage).toBe("please run this");
	});

	it("preserves multiline user messages", () => {
		const result = parseSkillBlock(`${block()}\n\nline one\nline two`);
		expect(result?.userMessage).toBe("line one\nline two");
	});

	it("returns null for non-skill text", () => {
		expect(parseSkillBlock("just some text")).toBeNull();
		expect(parseSkillBlock("")).toBeNull();
	});
});
