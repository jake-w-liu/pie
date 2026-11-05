import { openSync } from "node:fs";
import { getPackageJsonPath } from "../config.ts";

let pinnedDescriptor: number | undefined;

/**
 * Keep a read-only descriptor on a file of the running installation open for the life of the
 * process, and return it (undefined when the file cannot be opened or on Windows).
 *
 * Node closes each module file after reading it, so a running Pie otherwise holds nothing open in
 * its installation. scripts/refresh-pie.sh deletes an old installation only when lsof shows no
 * process with a file open under it; without this descriptor it deleted the installation that a
 * running session still loads modules and starts subagents from. refresh-pie.sh does not run on
 * Windows, so the descriptor is not opened there.
 */
export function pinInstallation(path: string = getPackageJsonPath()): number | undefined {
	if (pinnedDescriptor === undefined && process.platform !== "win32") {
		try {
			pinnedDescriptor = openSync(path, "r");
		} catch {
			// Without the descriptor, refresh-pie.sh can only see this process through other open files.
		}
	}
	return pinnedDescriptor;
}
