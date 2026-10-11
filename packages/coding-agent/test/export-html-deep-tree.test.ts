import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const templateSource = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");

function extractFunction(name: string): string {
	const start = templateSource.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`Missing function ${name}`);
	const bodyStart = templateSource.indexOf("{", start);
	let depth = 0;
	for (let index = bodyStart; index < templateSource.length; index++) {
		if (templateSource[index] === "{") depth++;
		if (templateSource[index] === "}" && --depth === 0) return templateSource.slice(start, index + 1);
	}
	throw new Error(`Unterminated function ${name}`);
}

function linearEntries(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index).toISOString(),
	}));
}

describe("export HTML large-session algorithms", () => {
	test("builds and flattens a 4,500-entry linear tree without overflowing the stack", () => {
		const entries = linearEntries(4_500);
		const buildTree = new Function("entries", "labelMap", `${extractFunction("buildTree")}; return buildTree();`) as (
			entries: ReturnType<typeof linearEntries>,
			labels: Map<string, string>,
		) => Array<{
			entry: { id: string };
			children: unknown[];
		}>;
		const roots = buildTree(entries, new Map());
		expect(roots).toHaveLength(1);

		const flattenTree = new Function(`${extractFunction("flattenTree")}; return flattenTree;`)() as (
			roots: unknown[],
			activeIds: Set<string>,
		) => unknown[];
		expect(flattenTree(roots, new Set(["entry-4499"]))).toHaveLength(4_500);
	});

	test("indexes tool results once and uses constant-time lookup", () => {
		expect(templateSource).toContain("const toolResultMap = new Map()");
		expect(templateSource).toContain("!toolResultMap.has(entry.message.toolCallId)");
		expect(extractFunction("findToolResult")).toContain("toolResultMap.get(toolCallId)");
		expect(extractFunction("findToolResult")).not.toContain("for (");
	});
});
