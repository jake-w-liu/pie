import { describe, expect, it } from "vitest";
import { assessClaim, buildPassages, type ResearchPassage } from "../../pi-web-access/source-check.ts";

function passage(id: string, text: string): ResearchPassage {
	return { passage_id: id, source_url: `https://example.com/${id}`, source_rank: 1, text, content_hash: "hash" };
}

describe("source-check claim polarity", () => {
	it("does not read a negated claim as supported", () => {
		const result = assessClaim("The moon is made of cheese.", [
			passage("p-1", "It is true that the moon is made of rock, not cheese."),
		]);
		expect(result.status).not.toBe("supported");
		expect(result.contradicting_passages).toContain("p-1");
	});

	it("treats an opposing predicate as contradicting", () => {
		const result = assessClaim("The moon is made of cheese.", [
			passage("p-1", "Scientists confirmed that the moon is made of rock rather than cheese."),
		]);
		expect(result.status).toBe("contradicted");
	});

	it("still supports a claim that the passage affirms", () => {
		const result = assessClaim("The moon is made of rock.", [
			passage("p-1", "It is true that the moon is made of rock."),
		]);
		expect(result.status).toBe("supported");
		expect(result.supporting_passages).toEqual(["p-1"]);
	});

	it("does not let one clause's support marker outweigh another clause's negation", () => {
		const result = assessClaim("Water boils at 100 degrees Celsius.", [
			passage(
				"p-1",
				"It is true that water freezes at 0 degrees. Water boils at 100 degrees Celsius is wrong; the value is 99.",
			),
		]);
		expect(result.status).not.toBe("supported");
	});

	it("reports unclear when the passage only mentions the terms", () => {
		const result = assessClaim("The moon is made of cheese.", [
			passage("p-1", "The moon orbits the earth and has a rocky surface."),
		]);
		expect(result.status).toBe("unclear");
	});
});

describe("source-check passage construction", () => {
	it("builds passages only from fetched page content", () => {
		const sources = [
			{
				rank: 1,
				url: "https://example.com/a",
				title: "A",
				snippet: "A persuasive but unfetched snippet about the claim.",
				quality: "unknown" as const,
				fetched: false,
			},
		];
		expect(buildPassages(sources, [], "the claim")).toEqual([]);
	});

	it("builds spanned passages when the page was fetched", () => {
		const sources = [
			{
				rank: 1,
				url: "https://example.com/a",
				title: "A",
				snippet: "the claim",
				quality: "unknown" as const,
				fetched: true,
			},
		];
		const passages = buildPassages(
			sources,
			[
				{
					url: "https://example.com/a",
					title: "A",
					content: "First sentence. The claim holds in the second sentence. Third.",
					error: null,
				},
			],
			"the claim",
		);
		expect(passages.length).toBeGreaterThan(0);
		for (const built of passages) {
			expect(built.extraction_span).toBeDefined();
		}
	});
});
