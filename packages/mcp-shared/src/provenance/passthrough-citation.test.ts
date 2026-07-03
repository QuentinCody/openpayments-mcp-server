import { describe, expect, it } from "vitest";
import { buildPassthroughCitation } from "./passthrough-citation";
import type { SourceDescriptor } from "./provenance";

const SOURCE: SourceDescriptor = {
	id: "civic",
	name: "CIViC",
	url: "https://civicdb.org",
	license: "CC0 1.0",
};

describe("buildPassthroughCitation", () => {
	it("returns {} when no source descriptor is provided", async () => {
		const out = await buildPassthroughCitation({
			server: "civic",
			tool: "civic_graphql_query",
			query: {},
			result: {},
		});
		expect(out).toEqual({});
	});

	it("builds a verifiable citation mirroring *_execute", async () => {
		const out = await buildPassthroughCitation({
			source: SOURCE,
			server: "civic",
			tool: "civic_graphql_query",
			query: { query: "{ genes { name } }" },
			result: { genes: [{ name: "BRAF" }] },
			recordCount: 1,
		});
		expect(out.citation?.source.name).toBe("CIViC");
		expect(out.citation?.source.license).toBe("CC0 1.0");
		expect(out.citation?.server).toBe("civic");
		expect(out.citation?.tool).toBe("civic_graphql_query");
		expect(out.citation?.record_count).toBe(1);
		expect(out.citation?.result_hash).toHaveLength(64); // sha256 hex
		expect(out.citation?.query_hash).toHaveLength(64);
		expect(out.citation?.text).toContain("CIViC");
	});

	it("passes through a data_access_id for staged results", async () => {
		const out = await buildPassthroughCitation({
			source: SOURCE,
			server: "civic",
			tool: "civic_graphql_query",
			query: {},
			result: { staged: true },
			dataAccessId: "abc123",
		});
		expect(out.citation?.data_access_id).toBe("abc123");
	});

	it("produces a re-checkable result_hash (same bytes → same hash)", async () => {
		const a = await buildPassthroughCitation({
			source: SOURCE,
			server: "civic",
			tool: "civic_graphql_query",
			query: { q: 1 },
			result: { x: [1, 2, 3] },
		});
		const b = await buildPassthroughCitation({
			source: SOURCE,
			server: "civic",
			tool: "civic_graphql_query",
			query: { q: 2 },
			result: { x: [1, 2, 3] },
		});
		expect(a.citation?.result_hash).toBe(b.citation?.result_hash);
		expect(a.citation?.query_hash).not.toBe(b.citation?.query_hash);
	});
});
