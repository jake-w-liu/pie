import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({ latest: undefined as undefined | FakeChild }));

class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	kill(): boolean {
		return true;
	}
}

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const child = new FakeChild();
		spawnState.latest = child;
		return child;
	}),
}));

import sshExtension from "../examples/extensions/ssh.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

describe("SSH extension bash streams", () => {
	it("identifies stdout and stderr chunks from remote commands", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const api = {
			registerFlag: vi.fn(),
			registerTool: vi.fn(),
			getFlag: vi.fn(() => "host:/remote"),
			on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
		};
		sshExtension(api as never);
		await handlers.get("session_start")?.(
			{},
			{
				ui: { setStatus: vi.fn(), notify: vi.fn(), theme: { fg: (_color: string, text: string) => text } },
			},
		);
		const eventResult = handlers.get("user_bash")?.({});
		const operations = eventResult.operations as BashOperations;
		const chunks: Array<[string, string | undefined]> = [];

		const execution = operations.exec("echo test", process.cwd(), {
			onData: (data, stream) => {
				chunks.push([data.toString(), stream]);
				return undefined;
			},
		});
		const child = spawnState.latest!;
		child.stdout.emit("data", Buffer.from("out"));
		child.stderr.emit("data", Buffer.from("err"));
		child.emit("close", 0);
		await execution;

		expect(chunks).toEqual([
			["out", "stdout"],
			["err", "stderr"],
		]);
	});
});
