import { describe, expect, it } from "vitest";
import type { StageResult } from "../staging/utils";
import {
	buildStagedEnvelope,
	buildStagedTableSummary,
	extractStagedColumns,
	preserveEnvelopeScalars,
	StagedPayloadAccessError,
} from "./staging-envelope";

describe("preserveEnvelopeScalars", () => {
	it("copies small scalar siblings but never clobbers existing envelope fields", () => {
		const staging: Record<string, unknown> = { total_rows: 5 };
		preserveEnvelopeScalars(
			{ count: 10, total_rows: "collides", big: "y".repeat(2000) },
			staging,
		);
		expect(staging.count).toBe(10);
		expect(staging.total_rows).toBe(5); // pre-existing field not overwritten
		expect(staging.big).toBeUndefined(); // over the 1KB scalar limit
	});

	it("no-ops for arrays and non-objects", () => {
		const s: Record<string, unknown> = {};
		preserveEnvelopeScalars([1, 2], s);
		preserveEnvelopeScalars("str", s);
		expect(s).toEqual({});
	});
});

describe("extractStagedColumns", () => {
	it("maps each table to its column names", () => {
		expect(
			extractStagedColumns({
				tables: { t: { columns: [{ name: "a" }, { name: "b" }] } },
			}),
		).toEqual({ t: ["a", "b"] });
	});

	it("returns undefined when there are no usable columns", () => {
		expect(extractStagedColumns(null)).toBeUndefined();
		expect(extractStagedColumns({})).toBeUndefined();
		expect(
			extractStagedColumns({ tables: { t: { columns: [] } } }),
		).toBeUndefined();
	});
});

describe("buildStagedTableSummary", () => {
	const mk = (
		tablesCreated: string[],
		counts: Record<string, number>,
		totalRows?: number,
	): StageResult =>
		({
			tablesCreated,
			totalRows,
			_staging: { table_row_counts: counts },
		}) as unknown as StageResult;

	it("summarizes zero, single, and multiple tables", () => {
		expect(buildStagedTableSummary(mk([], {}, 3))).toContain("3 rows");
		expect(buildStagedTableSummary(mk(["t"], { t: 5 }))).toContain(
			'table "t" [5 rows]',
		);
		const multi = buildStagedTableSummary(mk(["a", "b"], { a: 1 }));
		expect(multi).toContain("2 tables:");
		expect(multi).toContain("a [1]");
		expect(multi).toContain("b");
	});
});

describe("buildStagedEnvelope", () => {
	const staged = {
		dataAccessId: "ctgov_123",
		schema: {
			tables: { studies: { columns: [{ name: "nct_id" }, { name: "title" }] } },
		},
		tablesCreated: ["studies"],
		totalRows: 3,
		_staging: { table_row_counts: { studies: 3 } },
	} as unknown as StageResult;

	it("builds the standard envelope with columns + preserved scalars", () => {
		const env = buildStagedEnvelope({
			staged,
			responseBytes: 50_000,
			originalData: { count: 7, results: [] },
		});
		expect(env.__staged).toBe(true);
		expect(env.data_access_id).toBe("ctgov_123");
		expect(env.columns).toEqual({ studies: ["nct_id", "title"] });
		expect(env.count).toBe(7); // small scalar preserved
		expect(String(env.message)).toContain("auto-staged");
		expect(env.filter_warning).toBeUndefined();
	});

	it("attaches the over-match filter_warning (T1.3) when provided", () => {
		const env = buildStagedEnvelope({
			staged,
			responseBytes: 50_000,
			originalData: {},
			overMatch: {
				warning: "filter_may_not_have_applied",
				total: 2_944_145,
				detail: "filter likely no-op",
			},
		});
		expect((env.filter_warning as { total?: number })?.total).toBe(2_944_145);
		expect(String(env.message)).toContain("filter likely no-op");
	});

	it("self-computes the over-match warning from originalData when not provided", () => {
		const env = buildStagedEnvelope({
			staged,
			responseBytes: 50_000,
			originalData: {
				meta: { total: 2_944_145, sorted_by_relevance: false },
				results: [],
			},
		});
		expect((env.filter_warning as { warning?: string })?.warning).toBe(
			"filter_may_not_have_applied",
		);
		expect(String(env.message)).toContain("filter may not have applied");
	});
});

describe("staged-envelope tripwire (silent-empty guard)", () => {
	const staged = {
		dataAccessId: "epmc_abc",
		schema: { tables: { data: { columns: [{ name: "id" }] } } },
		tablesCreated: ["data"],
		totalRows: 58,
		_staging: { table_row_counts: { data: 58 } },
	} as unknown as StageResult;

	const envelope = () =>
		buildStagedEnvelope({ staged, responseBytes: 120_000, originalData: {} });

	it("throws instead of silently reading empty — the live Europe PMC failure", () => {
		// Observed 2026-07-15: a resultType=core search auto-staged, so this exact
		// idiom collapsed to [] and the run reported zero hits for a query whose
		// upstream had returned 58.
		const r = envelope();
		expect(() => (r as { resultList?: { result?: unknown[] } }).resultList?.result ?? []).toThrow(
			StagedPayloadAccessError,
		);
		expect(() => (r as { data?: unknown }).data || (r as { results?: unknown }).results || []).toThrow(
			/AUTO-STAGED \(58 rows\)/,
		);
	});

	it("names the recovery path in the error", () => {
		let msg = "";
		try {
			void (envelope() as { hits?: unknown }).hits;
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toContain('api.query("epmc_abc"');
		expect(msg).toContain("THIS IS NOT AN EMPTY RESULT");
	});

	it("leaves serialization across the isolate boundary untouched", () => {
		const r = envelope();
		// Non-enumerable: JSON.stringify / spread / Object.keys must not trip.
		const round = JSON.parse(JSON.stringify(r));
		expect(round.__staged).toBe(true);
		expect(round.total_rows).toBe(58);
		expect(round.resultList).toBeUndefined();
		expect(() => ({ ...r })).not.toThrow();
		expect(Object.keys(r)).not.toContain("results");
	});

	it("still exposes the real envelope fields", () => {
		const r = envelope();
		expect(r.__staged).toBe(true);
		expect(r.data_access_id).toBe("epmc_abc");
		expect(r.total_rows).toBe(58);
	});

	it("never shadows a genuinely preserved scalar sibling", () => {
		const r = buildStagedEnvelope({
			staged,
			responseBytes: 120_000,
			originalData: { data: "a real scalar" },
		});
		expect(r.data).toBe("a real scalar"); // preserved — tripwire must skip it
	});
});
