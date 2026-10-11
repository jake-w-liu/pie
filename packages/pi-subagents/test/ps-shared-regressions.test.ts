import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { registerExternalJobProvider } from "../src/api/external-job-provider.ts";
import { requestExternalJobOperation, serviceExternalJobBridgeRequests } from "../src/runs/shared/external-job-bridge.ts";
import { fuzzyResolveModel } from "../src/runs/shared/model-fallback.ts";
import { applyNestedEvent, type NestedEventRecord, type NestedRegistry } from "../src/runs/shared/nested-events.ts";
import type { NestedRunSummary } from "../src/shared/types.ts";

function runNode(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf-8").on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
	});
}

function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const poll = (): void => {
			if (fs.existsSync(file)) return resolve();
			if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${file}`));
			setTimeout(poll, 10);
		};
		poll();
	});
}

describe("shared run regressions", () => {
	it("preserves descendants whose parent is attached to a step", () => {
		const summary = (id: string, parentRunId: string, parentStepIndex?: number): NestedRunSummary => ({
			id,
			parentRunId,
			...(parentStepIndex === undefined ? {} : { parentStepIndex }),
			depth: 1,
			path: [{ runId: parentRunId }],
			state: "running",
			...(id === "A" ? { steps: [{ agent: "step-agent", status: "running" }] } : {}),
		});
		const event = (child: NestedRunSummary, parentRunId: string): NestedEventRecord => ({
			type: "subagent.nested.started",
			ts: Date.now(),
			rootRunId: "root",
			parentRunId,
			capabilityToken: "token",
			child,
		});
		let registry: NestedRegistry = { rootRunId: "root", updatedAt: 0, children: [], processedEvents: [] };
		registry = applyNestedEvent(registry, event(summary("A", "root"), "root"));
		registry = applyNestedEvent(registry, event(summary("B", "A", 0), "A"));
		registry = applyNestedEvent(registry, event(summary("C", "B"), "B"));

		expect(registry.children.map((child) => child.id)).toEqual(["A"]);
		expect(registry.children[0]?.steps?.[0]?.children?.[0]?.children?.map((child) => child.id)).toEqual(["C"]);
	});

	it("prefers a normalized exact dated model id before date-stripped matches", () => {
		const models = [
			{ provider: "p", id: "foo-2025-01-01", fullId: "p/foo-2025-01-01" },
			{ provider: "p", id: "foo-2025-02-02", fullId: "p/foo-2025-02-02" },
		];
		expect(fuzzyResolveModel("p/Foo_2025_02_02", models, "p")).toBe("p/foo-2025-02-02");
	});

	it("merges exclusions recorded by processes with stale in-memory snapshots", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-exclusion-concurrency-"));
		const store = path.join(root, "exclusions.json");
		const ready = path.join(root, "a-ready");
		const proceed = path.join(root, "a-proceed");
		const now = Date.now();
		fs.writeFileSync(store, JSON.stringify({
			version: 1,
			exclusions: Array.from({ length: 200 }, (_unused, index) => ({
				provider: "provider",
				modelId: `old-${index}`,
				recordedAt: now - index - 1,
				expiresAt: now + 60_000,
			})),
		}));
		const moduleUrl = pathToFileURL(
			fileURLToPath(new URL("../src/runs/shared/model-exclusions.ts", import.meta.url)),
		).href;
		const script = path.join(root, "worker.ts");
		fs.writeFileSync(script, `
import * as fs from "node:fs";
const [mode, store, ready, proceed, moduleUrl] = process.argv.slice(2);
process.env.PI_MODEL_EXCLUSIONS_PATH = store;
const exclusions = await import(moduleUrl);
if (mode === "a") {
  exclusions.filterFallbackCandidates(["provider/initial"]);
  fs.writeFileSync(ready, "");
  while (!fs.existsSync(proceed)) await new Promise((resolve) => setTimeout(resolve, 5));
  exclusions.recordModelFailure({ provider: "provider", modelId: "model-a", ttlMs: 60_000 });
} else {
  exclusions.recordModelFailure({ provider: "provider", modelId: "model-b", ttlMs: 60_000 });
}
`);
		const workerA = runNode(script, ["a", store, ready, proceed, moduleUrl]);
		await waitForFile(ready);
		await runNode(script, ["b", store, ready, proceed, moduleUrl]);
		fs.writeFileSync(proceed, "");
		await workerA;
		const persisted = JSON.parse(fs.readFileSync(store, "utf-8")) as { exclusions: Array<{ modelId?: string }> };
		const modelIds = persisted.exclusions.map((entry) => entry.modelId);
		expect(persisted.exclusions).toHaveLength(200);
		expect(modelIds).toContain("model-a");
		expect(modelIds).toContain("model-b");
	}, 20_000);

	it("recovers a corrupt exclusion store instead of blocking persistence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-exclusion-corrupt-"));
		const store = path.join(root, "exclusions.json");
		fs.writeFileSync(store, '{"version":1,"exclusions":[{"provider":"provider",');
		const moduleUrl = pathToFileURL(
			fileURLToPath(new URL("../src/runs/shared/model-exclusions.ts", import.meta.url)),
		).href;
		process.env.PI_MODEL_EXCLUSIONS_PATH = store;
		try {
			const exclusions = (await import(moduleUrl)) as typeof import("../src/runs/shared/model-exclusions.ts");
			exclusions.recordModelFailure({ provider: "provider", modelId: "recovered", ttlMs: 60_000 });
			exclusions.flushPersist();
			const persisted = JSON.parse(fs.readFileSync(store, "utf-8")) as { exclusions: Array<{ modelId?: string }> };
			expect(persisted.exclusions.map((entry) => entry.modelId)).toContain("recovered");
		} finally {
			delete process.env.PI_MODEL_EXCLUSIONS_PATH;
		}
	});

	it("serializes concurrent history rotation and append", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-history-concurrency-"));
		const history = path.join(root, "run-history.jsonl");
		const legacy = Array.from({ length: 1201 }, (_unused, index) => JSON.stringify({
			agent: "worker", task: `legacy-${index}`, ts: index, status: "ok", duration: 1,
		}));
		fs.writeFileSync(history, `${legacy.join("\n")}\n`);
		const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/runs/shared/run-history.ts", import.meta.url))).href;
		const script = path.join(root, "worker.ts");
		const go = path.join(root, "go");
		fs.writeFileSync(script, `
import * as fs from "node:fs";
const [index, ready, go, moduleUrl] = process.argv.slice(2);
const history = await import(moduleUrl);
fs.writeFileSync(ready, "");
while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
history.recordRun("worker", \`child-\${index}\`, 0, 1);
`);
		const count = 12;
		const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
		delete childEnv.PIE_CODING_AGENT_DIR;
		const children = Array.from({ length: count }, (_unused, index) => {
			const ready = path.join(root, `ready-${index}`);
			return { ready, run: runNode(script, [String(index), ready, go, moduleUrl], childEnv) };
		});
		await Promise.all(children.map(({ ready }) => waitForFile(ready)));
		fs.writeFileSync(go, "");
		await Promise.all(children.map(({ run }) => run));
		const entries = fs.readFileSync(history, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { taskHash?: string });
		const hashes = new Set(entries.map((entry) => entry.taskHash));
		for (let index = 0; index < count; index++) {
			expect(hashes.has(createHash("sha256").update(`child-${index}`).digest("hex"))).toBe(true);
		}
	}, 30_000);

	it("publishes a claimed non-dispatch bridge response", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-job-response-"));
		const requestsDir = path.join(root, "external-job-requests");
		const responsesDir = path.join(root, "external-job-responses");
		const publicationSnapshots: Array<{ canonicalRequestExists: boolean; completionClaims: number }> = [];
		const originalRenameSync = fsDefault.renameSync;
		fsDefault.renameSync = ((oldPath, newPath) => {
			const destination = String(newPath);
			if (path.dirname(destination) === responsesDir && path.extname(destination) === ".json") {
				const id = path.basename(destination, ".json");
				publicationSnapshots.push({
					canonicalRequestExists: fs.existsSync(path.join(requestsDir, `${id}.json`)),
					completionClaims: fs.readdirSync(requestsDir).filter((file) => file.startsWith(`${id}.json.completing-`)).length,
				});
			}
			return originalRenameSync(oldPath, newPath);
		}) as typeof fsDefault.renameSync;
		syncBuiltinESMExports();
		const unregister = registerExternalJobProvider({
			name: "round2-bridge-fixture",
			start: () => ({ providerJobId: "job-1", state: "running" }),
			status: () => ({ providerJobId: "job-1", state: "completed" }),
			result: () => ({ providerJobId: "job-1", state: "completed", output: "done" }),
			reattach: () => ({ providerJobId: "job-1", state: "running" }),
		});
		try {
			const operation = requestExternalJobOperation(root, {
				operation: "status",
				provider: "round2-bridge-fixture",
				providerJobId: "job-1",
			}, 1_000);
			serviceExternalJobBridgeRequests(root);
			await expect(operation).resolves.toEqual({ providerJobId: "job-1", state: "completed" });
			expect(publicationSnapshots).toEqual([{ canonicalRequestExists: false, completionClaims: 1 }]);
			expect(fs.readdirSync(requestsDir)).toEqual([]);
			expect(fs.readdirSync(responsesDir)).toEqual([]);
		} finally {
			unregister();
			fsDefault.renameSync = originalRenameSync;
			syncBuiltinESMExports();
		}
	});

	it("retires a timed-out non-dispatch bridge request", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-job-timeout-"));
		await expect(requestExternalJobOperation(root, {
			operation: "status",
			provider: "fake",
			providerJobId: "job-1",
		}, 10)).rejects.toMatchObject({ code: "bridge-timeout" });
		expect(fs.readdirSync(path.join(root, "external-job-requests"))).toEqual([]);
		expect(fs.readdirSync(path.join(root, "external-job-responses"))).toEqual([]);
	});

	it("expires and retires an abandoned non-dispatch completion claim", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-job-claimed-timeout-"));
		const operation = requestExternalJobOperation(root, {
			operation: "status",
			provider: "fake",
			providerJobId: "job-1",
		}, 10);
		const requests = path.join(root, "external-job-requests");
		const requestFile = fs.readdirSync(requests).find((file) => file.endsWith(".json"));
		expect(requestFile).toBeDefined();
		fs.renameSync(path.join(requests, requestFile!), path.join(requests, `${requestFile}.completing-dead-host`));

		await expect(operation).rejects.toMatchObject({ code: "bridge-timeout" });
		expect(fs.readdirSync(requests)).toEqual([]);
		expect(fs.readdirSync(path.join(root, "external-job-responses"))).toEqual([]);
	});
});
