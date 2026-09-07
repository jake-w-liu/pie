import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "./utils.ts";
import { getPackageRoot } from "./package-root.ts";

export function getPromptDirectories(cwd: string) {
	return {
		package: path.join(getPackageRoot(), "prompts"),
		user: path.join(getAgentDir(), "prompts"),
		project: path.join(getProjectConfigDir(cwd), "prompts"),
	};
}
