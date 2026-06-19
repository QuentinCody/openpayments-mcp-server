import { describe, expect, it } from "vitest";
import { extractItems, extractNextCursor, paginateAll, type PageFetcher } from "./paginate";

describe("extractItems", () => {
	it("returns a bare array directly", () => {
		expect(extractItems([1, 2, 3])).toEqual({ items: [1, 2, 3] });
	});

	it("honors an explicit dot-path itemsField", () => {
		expect(extractItems({ payload: { rows: [{ a: 1 }] } }, "payload.rows")).toEqual({
			items: [{ a: 1 }],
			field: "payload.rows",
		});
		// missing path → empty
		expect(extractItems({ payload: {} }, "payload.rows").items).toEqual([]);
	});

	it("auto-detects common envelope keys", () => {
		expect(extractItems({ count: 2, results: [{ a: 1 }, { a: 2 }] })).toEqual({
			items: [{ a: 1 }, { a: 2 }],
			field: "results",
		});
	});

	it("auto-detects NCBI esearchresult.idlist", () => {
		const resp = { esearchresult: { count: "266", idlist: ["1", "2", "3"] } };
		expect(extractItems(resp)).toEqual({ items: ["1", "2", "3"], field: "esearchresult.idlist" });
	});

	it("returns empty when nothing array-like is found", () => {
		expect(extractItems({ foo: "bar" }).items).toEqual([]);
		expect(extractItems(null).items).toEqual([]);
	});
});

describe("extractNextCursor", () => {
	it("reads an explicit nextField", () => {
		expect(extractNextCursor({ paging: { token: "abc" } }, "paging.token")).toBe("abc");
	});

	it("auto-detects common cursor keys and stringifies numbers", () => {
		expect(extractNextCursor({ nextPageToken: "xyz" })).toBe("xyz");
		expect(extractNextCursor({ next: 5 })).toBe("5");
	});

	it("returns undefined when no cursor present or empty", () => {
		expect(extractNextCursor({ next: "" })).toBeUndefined();
		expect(extractNextCursor({ foo: 1 })).toBeUndefined();
	});
});

/** Build a fetcher over a fixed pool using offset/limit semantics. */
function offsetPool(total: number, key = "results"): { fetch: PageFetcher; calls: Record<string, unknown>[] } {
	const calls: Record<string, unknown>[] = [];
	const fetch: PageFetcher = async (params) => {
		calls.push(params);
		const offset = Number(params.offset ?? 0);
		const limit = Number(params.limit ?? 100);
		const slice = Array.from({ length: total }, (_, i) => i).slice(offset, offset + limit);
		return { count: total, [key]: slice };
	};
	return { fetch, calls };
}

describe("paginateAll — offset strategy", () => {
	it("walks every page to completion and reports complete", async () => {
		const { fetch, calls } = offsetPool(250);
		const result = await paginateAll(fetch, {}, { pageSize: 100 });
		expect(result.items).toHaveLength(250);
		expect(result.pages).toBe(3); // 100 + 100 + 50
		expect(result.total_available).toBe(250);
		expect(result.completeness).toMatchObject({ complete: true, total_available: 250, returned: 250 });
		expect(calls[0]).toMatchObject({ offset: 0, limit: 100 });
		expect(calls[2]).toMatchObject({ offset: 200, limit: 100 });
	});

	it("stops on a short page even without a known total", async () => {
		const fetch: PageFetcher = async (params) => {
			const offset = Number(params.offset ?? 0);
			return { results: offset === 0 ? [1, 2, 3] : [] }; // page 1 short (3 < 5)
		};
		const result = await paginateAll(fetch, {}, { pageSize: 5 });
		expect(result.items).toEqual([1, 2, 3]);
		expect(result.pages).toBe(1);
		expect(result.completeness.complete).toBe(true);
	});

	it("flags row_limit truncation when the max item cap is hit", async () => {
		const { fetch } = offsetPool(1000);
		const result = await paginateAll(fetch, {}, { pageSize: 100, max: 150 });
		expect(result.items).toHaveLength(150);
		expect(result.completeness.complete).toBe(false);
		expect(result.completeness.truncation?.reason).toBe("row_limit");
	});

	it("flags page_limit truncation when the maxPages cap is hit", async () => {
		const { fetch } = offsetPool(1000);
		const result = await paginateAll(fetch, {}, { pageSize: 100, maxPages: 2 });
		expect(result.pages).toBe(2);
		expect(result.completeness.complete).toBe(false);
		expect(result.completeness.truncation?.reason).toBe("page_limit");
	});

	it("honors custom offset/limit param names (NCBI retstart/retmax)", async () => {
		const calls: Record<string, unknown>[] = [];
		const fetch: PageFetcher = async (params) => {
			calls.push(params);
			const start = Number(params.retstart ?? 0);
			const n = Number(params.retmax ?? 0);
			const idlist = Array.from({ length: 7 }, (_, i) => String(i)).slice(start, start + n);
			return { esearchresult: { count: "7", idlist } };
		};
		const result = await paginateAll(fetch, { db: "nuccore" }, {
			offsetParam: "retstart",
			limitParam: "retmax",
			pageSize: 3,
		});
		expect(result.items).toHaveLength(7);
		expect(result.completeness.complete).toBe(true);
		expect(calls[0]).toMatchObject({ db: "nuccore", retstart: 0, retmax: 3 });
	});
});

describe("paginateAll — page strategy", () => {
	it("increments page numbers until a short page", async () => {
		const fetch: PageFetcher = async (params) => {
			const page = Number(params.page ?? 1);
			const size = Number(params.per_page ?? 0);
			const all = Array.from({ length: 12 }, (_, i) => i);
			const start = (page - 1) * size;
			return { data: all.slice(start, start + size) };
		};
		const result = await paginateAll(fetch, {}, { strategy: "page", pageSize: 5 });
		expect(result.items).toHaveLength(12);
		expect(result.pages).toBe(3); // 5 + 5 + 2
		expect(result.completeness.complete).toBe(true);
	});
});

describe("paginateAll — cursor strategy", () => {
	it("follows next-cursors until exhausted", async () => {
		const pages: Record<string, { items: number[]; next?: string }> = {
			"": { items: [1, 2], next: "c1" },
			c1: { items: [3, 4], next: "c2" },
			c2: { items: [5] },
		};
		const seen: string[] = [];
		const fetch: PageFetcher = async (params) => {
			const cur = String(params.cursor ?? "");
			seen.push(cur);
			const p = pages[cur];
			return { items: p.items, ...(p.next ? { next: p.next } : {}) };
		};
		const result = await paginateAll(fetch, {}, { strategy: "cursor" });
		expect(result.items).toEqual([1, 2, 3, 4, 5]);
		expect(result.pages).toBe(3);
		expect(seen).toEqual(["", "c1", "c2"]);
		expect(result.completeness.complete).toBe(true);
	});
});

describe("paginateAll — completeness reconciliation", () => {
	it("flags incompleteness when a natural stop falls short of the reported total", async () => {
		// total says 100 but the endpoint only ever returns 10 then stops short
		const fetch: PageFetcher = async () => ({ total_count: 100, results: [1, 2, 3] });
		const result = await paginateAll(fetch, {}, { pageSize: 5 });
		expect(result.items).toEqual([1, 2, 3]);
		expect(result.completeness.complete).toBe(false);
		expect(result.completeness.truncation?.reason).toBe("page_limit");
		expect(result.completeness.total_available).toBe(100);
	});
});

describe("paginateAll — cursor strategy with full-URL next (CourtListener/DRF)", () => {
	it("re-sends the extracted cursor token, not the whole URL", async () => {
		// Mirrors DRF: each `next` is an absolute URL embedding ?cursor=<token>.
		const pages: Record<string, { items: number[]; next?: string }> = {
			"": { items: [1, 2], next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=c1" },
			c1: { items: [3, 4], next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=c2" },
			c2: { items: [5] },
		};
		const seen: string[] = [];
		const fetch: PageFetcher = async (params) => {
			const cur = String(params.cursor ?? "");
			seen.push(cur);
			const p = pages[cur];
			return { count: 5, next: p.next ?? null, results: p.items };
		};
		const result = await paginateAll(fetch, {}, { strategy: "cursor", itemsField: "results" });
		expect(result.items).toEqual([1, 2, 3, 4, 5]);
		expect(result.pages).toBe(3);
		// CRITICAL: the cursor param must be the bare token, never the full URL.
		expect(seen).toEqual(["", "c1", "c2"]);
		expect(seen.some((s) => s.startsWith("http"))).toBe(false);
		expect(result.completeness.complete).toBe(true);
	});
});
