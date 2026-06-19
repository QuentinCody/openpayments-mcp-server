import { describe, expect, it } from "vitest";
import {
	asCount,
	inferUpstreamTotal,
	paginationCompleteness,
	deriveMaterializationCompleteness,
	mergeCompleteness,
} from "./completeness";

describe("asCount", () => {
	it("accepts non-negative finite numbers and truncates", () => {
		expect(asCount(0)).toBe(0);
		expect(asCount(266)).toBe(266);
		expect(asCount(12.9)).toBe(12);
	});

	it("rejects negative, NaN, and infinite numbers", () => {
		expect(asCount(-1)).toBeUndefined();
		expect(asCount(Number.NaN)).toBeUndefined();
		expect(asCount(Number.POSITIVE_INFINITY)).toBeUndefined();
	});

	it("parses numeric strings (NCBI returns counts as strings)", () => {
		expect(asCount("266")).toBe(266);
		expect(asCount("  42 ")).toBe(42);
		expect(asCount("0")).toBe(0);
	});

	it("rejects non-numeric and signed strings", () => {
		expect(asCount("abc")).toBeUndefined();
		expect(asCount("-5")).toBeUndefined();
		expect(asCount("3.5")).toBeUndefined();
		expect(asCount("")).toBeUndefined();
	});

	it("unwraps Elasticsearch {value, relation} total objects", () => {
		expect(asCount({ value: 5, relation: "eq" })).toBe(5);
		expect(asCount({ value: "17" })).toBe(17);
	});

	it("rejects objects without a value, arrays, and other types", () => {
		expect(asCount({ relation: "gte" })).toBeUndefined();
		expect(asCount([1, 2, 3])).toBeUndefined();
		expect(asCount(null)).toBeUndefined();
		expect(asCount(true)).toBeUndefined();
		expect(asCount(undefined)).toBeUndefined();
	});
});

describe("inferUpstreamTotal", () => {
	it("returns undefined for non-objects and arrays", () => {
		expect(inferUpstreamTotal(null)).toBeUndefined();
		expect(inferUpstreamTotal("x")).toBeUndefined();
		expect(inferUpstreamTotal([1, 2])).toBeUndefined();
	});

	it("reads a root-level total_count", () => {
		expect(inferUpstreamTotal({ total_count: 50000, reports: [] })).toBe(50000);
	});

	it("reads NCBI esearchresult.count (string, nested)", () => {
		const envelope = {
			header: { type: "esearch", version: "0.3" },
			esearchresult: { count: "266", retmax: "20", retstart: "0", idlist: [] },
		};
		expect(inferUpstreamTotal(envelope)).toBe(266);
	});

	it("reads Solr numFound and Elasticsearch hits.total", () => {
		expect(inferUpstreamTotal({ response: { numFound: 9 } })).toBe(9);
		expect(inferUpstreamTotal({ hits: { total: { value: 12, relation: "eq" } } })).toBe(12);
	});

	it("falls back to a bare root count (DRF-style list)", () => {
		expect(inferUpstreamTotal({ count: 137, next: "http://x?page=2", results: [] })).toBe(137);
	});

	it("prefers an explicit total_count over an ambiguous count", () => {
		expect(inferUpstreamTotal({ count: 50, total_count: 5000 })).toBe(5000);
	});

	it("ignores a container key whose value is an array (not a metadata object)", () => {
		// `hits` here is an array of results, not an ES {total} object → no false match
		expect(inferUpstreamTotal({ hits: [{ id: 1 }, { id: 2 }] })).toBeUndefined();
	});

	it("returns undefined when no recognizable total field is present", () => {
		expect(inferUpstreamTotal({ results: [{ a: 1 }], foo: "bar" })).toBeUndefined();
	});
});

describe("paginationCompleteness", () => {
	it("returns undefined when either input is unknown", () => {
		expect(paginationCompleteness(undefined, 10)).toBeUndefined();
		expect(paginationCompleteness(100, undefined)).toBeUndefined();
	});

	it("flags incompleteness when upstream total exceeds retrieved", () => {
		const c = paginationCompleteness(50000, 50);
		expect(c).toMatchObject({ complete: false, total_available: 50000, returned: 50 });
		expect(c?.truncation?.reason).toBe("page_limit");
		expect(c?.truncation?.detail).toContain("50000");
		expect(c?.truncation?.remedy).toContain("getAll");
	});

	it("reports complete when retrieved meets or exceeds the total", () => {
		expect(paginationCompleteness(50, 50)).toEqual({ complete: true, total_available: 50, returned: 50 });
		expect(paginationCompleteness(50, 60)).toEqual({ complete: true, total_available: 50, returned: 60 });
	});
});

describe("deriveMaterializationCompleteness", () => {
	it("is complete when no rows failed", () => {
		expect(deriveMaterializationCompleteness({ inputRows: 100, failedRows: 0, returned: 100 })).toEqual({
			complete: true,
			returned: 100,
		});
		// failedRows undefined → treated as no failure
		expect(deriveMaterializationCompleteness({ returned: 5 })).toEqual({ complete: true, returned: 5 });
	});

	it("is incomplete when rows were dropped, using the provided warning", () => {
		const c = deriveMaterializationCompleteness({
			inputRows: 100,
			failedRows: 12,
			returned: 88,
			dataLossWarning: "12 of 100 rows (12.0%) failed to stage.",
		});
		expect(c.complete).toBe(false);
		expect(c.returned).toBe(88);
		expect(c.truncation?.reason).toBe("insertion_failure");
		expect(c.truncation?.detail).toBe("12 of 100 rows (12.0%) failed to stage.");
	});

	it("synthesizes a detail when no warning string is supplied", () => {
		const withInput = deriveMaterializationCompleteness({ inputRows: 30, failedRows: 3 });
		expect(withInput.truncation?.detail).toContain("3 of 30");
		const withoutInput = deriveMaterializationCompleteness({ failedRows: 3 });
		expect(withoutInput.truncation?.detail).toContain("3 row");
		expect(withoutInput.truncation?.detail).not.toContain("of");
	});
});

describe("mergeCompleteness", () => {
	it("returns undefined when no part is defined", () => {
		expect(mergeCompleteness(undefined, undefined)).toBeUndefined();
	});

	it("is complete only when every defined part is complete", () => {
		expect(mergeCompleteness({ complete: true, returned: 5 }, undefined)).toEqual({
			complete: true,
			returned: 5,
		});
	});

	it("takes the truncation from the first incomplete part (priority order)", () => {
		const pagination = {
			complete: false as const,
			total_available: 5000,
			returned: 50,
			truncation: { reason: "page_limit" as const, detail: "pages" },
		};
		const materialization = {
			complete: false as const,
			returned: 50,
			truncation: { reason: "insertion_failure" as const, detail: "rows" },
		};
		const merged = mergeCompleteness(pagination, materialization);
		expect(merged?.complete).toBe(false);
		expect(merged?.total_available).toBe(5000);
		expect(merged?.returned).toBe(50);
		expect(merged?.truncation?.reason).toBe("page_limit");
	});

	it("an incomplete part makes the whole incomplete even if another is complete", () => {
		const merged = mergeCompleteness(
			{ complete: true, total_available: 50, returned: 50 },
			{ complete: false, returned: 50, truncation: { reason: "insertion_failure" } },
		);
		expect(merged?.complete).toBe(false);
		expect(merged?.truncation?.reason).toBe("insertion_failure");
		// total_available picked from the first part that defines it
		expect(merged?.total_available).toBe(50);
	});
});
