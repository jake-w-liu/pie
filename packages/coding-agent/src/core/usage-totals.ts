import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export const SUMMARIZATION_USAGE_TYPE = "pi.summarization.usage";

/** Read summary usage once, including attempts that never produced a checkpoint. */
export function getSummaryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const details = entry.details;
		if (
			!entry.fromHook &&
			details &&
			typeof details === "object" &&
			"usageRecorded" in details &&
			details.usageRecorded === true
		)
			return undefined;
		return entry.usage;
	}
	if (entry.type !== "custom" || entry.customType !== SUMMARIZATION_USAGE_TYPE) return undefined;
	if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
	const usage = entry.data as Partial<Usage>;
	const cost = usage.cost;
	if (!cost || typeof cost !== "object") return undefined;
	const values = [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
		cost.input,
		cost.output,
		cost.cacheRead,
		cost.cacheWrite,
		cost.total,
	];
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
	if (
		[usage.reasoning, usage.cacheWrite1h].some(
			(value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value)),
		)
	)
		return undefined;
	return usage as Usage;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else {
			usage = getSummaryUsage(entry);
			if (usage) key = "Tools/summaries";
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
