import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

/**
 * Split an editor command into argv with shell-like quoting: single quotes
 * are literal, double quotes honor `\"` and `\\` escapes, and a backslash
 * outside quotes escapes the next character. Keeps quoted install paths
 * (notably Windows `C:\...` paths) intact.
 */
export function splitEditorCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: string | undefined;
	let hasToken = false;
	const pushToken = (): void => {
		if (hasToken) {
			args.push(current);
			current = "";
			hasToken = false;
		}
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote === "'") {
			// Single quotes: everything literal until the closing quote.
			if (char === "'") {
				quote = undefined;
			} else {
				current += char;
				hasToken = true;
			}
		} else if (quote === '"') {
			if (char === '"') {
				quote = undefined;
			} else if (char === "\\" && i + 1 < command.length && '"\\'.includes(command[i + 1]!)) {
				current += command[++i]!;
				hasToken = true;
			} else {
				current += char;
				hasToken = true;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			hasToken = true;
		} else if (char === "\\" && i + 1 < command.length) {
			current += command[++i]!;
			hasToken = true;
		} else if (/\s/.test(char)) {
			pushToken();
		} else {
			current += char;
			hasToken = true;
		}
	}
	pushToken();
	return args;
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = splitEditorCommand(options.command);
		if (!editor) return { status: "failed" };
		process.stdout.write(
			`Launching external editor: ${options.command}\n${APP_NAME} will resume when the editor exits.\n`,
		);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
