import * as fs from "node:fs";
import * as path from "node:path";
import { getPackageRoot } from "../shared/package-root.ts";

export const SUBAGENT_GUIDE_TOPICS = [
	"overview",
	"workflows",
	"agents",
	"missions",
	"observability",
	"tool-reference",
	"configuration",
	"models",
	"watchdog",
	"extension-api",
] as const;

export type SubagentGuideTopic = (typeof SUBAGENT_GUIDE_TOPICS)[number];

const packageRoot = getPackageRoot();

// Keep guide help and the shipped skill on the same maintained references.
const GUIDE_SOURCES: Record<SubagentGuideTopic, readonly string[]> = {
	overview: ["SKILL.md"],
	workflows: ["references/execution-controls.md"],
	agents: ["references/management-authoring-rpc.md", "references/prompting-and-roles.md"],
	missions: ["references/execution-controls.md"],
	observability: ["references/execution-controls.md", "references/constraints-and-recipes.md"],
	"tool-reference": ["references/execution-controls.md", "references/management-authoring-rpc.md"],
	configuration: ["references/constraints-and-recipes.md", "references/prompting-and-roles.md"],
	models: ["references/prompting-and-roles.md"],
	watchdog: ["references/execution-controls.md"],
	"extension-api": ["references/management-authoring-rpc.md"],
};

function isGuideTopic(value: string): value is SubagentGuideTopic {
	return (SUBAGENT_GUIDE_TOPICS as readonly string[]).includes(value);
}

export function readSubagentGuide(topic = "overview", root = packageRoot): string {
	if (!isGuideTopic(topic)) {
		return `Unknown subagents guide topic '${topic}'. Valid topics: ${SUBAGENT_GUIDE_TOPICS.join(", ")}. No files were changed.`;
	}
	try {
		return GUIDE_SOURCES[topic]
			.map((source) => fs.readFileSync(path.join(root, "skills", "pi-subagents", source), "utf-8"))
			.join("\n\n");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read packaged subagents guide '${topic}': ${message}`, { cause: error instanceof Error ? error : undefined });
	}
}
