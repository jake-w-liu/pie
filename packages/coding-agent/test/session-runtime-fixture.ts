import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { InlineExtension, ToolDefinition } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

export async function createSessionRuntimeFixture(
	options: {
		cwd?: string;
		sessionManager?: SessionManager;
		extensions?: InlineExtension[];
		customTools?: ToolDefinition[];
	} = {},
) {
	const harness = await createHarness({ settings: { compaction: { enabled: false } } });
	const cwd = options.cwd ?? harness.tempDir;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const resourceLoader = createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult(options.extensions ?? [], cwd),
		});
		const services = {
			cwd,
			agentDir,
			resourceLoader,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			diagnostics: [],
		};
		const result = await createAgentSession({
			...services,
			sessionManager,
			sessionStartEvent,
			model: harness.getModel(),
			noTools: "all",
			customTools: options.customTools,
			tools: options.customTools?.map((tool) => tool.name),
		});
		return { ...result, services, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: harness.tempDir,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
	});
	return {
		runtime,
		harness,
		async cleanup() {
			await runtime.session.abort();
			await runtime.dispose();
			harness.cleanup();
		},
	};
}
