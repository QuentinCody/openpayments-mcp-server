import { describe, expect, it } from "vitest";
import { workspaceCompleteness } from "./workspace-completeness";

describe("workspaceCompleteness", () => {
	it("flags incomplete pagination when fewer rows materialized than the upstream total", () => {
		expect(workspaceCompleteness(100, { row_count: 25 })).toEqual({
			complete: false,
			total_available: 100,
			returned: 25,
		});
	});

	it("flags incomplete materialization when the DO reports failed rows (no upstream total)", () => {
		expect(
			workspaceCompleteness(undefined, { row_count: 9, completeness: { complete: false, failed_rows: 3 } }),
		).toEqual({ complete: false, returned: 9 });
	});

	it("reports incomplete materialization even when row_count is absent", () => {
		expect(workspaceCompleteness(undefined, { completeness: { complete: false } })).toEqual({ complete: false });
	});

	it("reports complete when the DO confirms full materialization", () => {
		expect(workspaceCompleteness(undefined, { row_count: 10, completeness: { complete: true } })).toEqual({
			complete: true,
		});
	});

	it("reports complete when every upstream row was fetched", () => {
		expect(workspaceCompleteness(100, { row_count: 100 })).toEqual({ complete: true });
	});

	it("treats a known upstream total with absent row_count as complete (cannot prove a gap)", () => {
		expect(workspaceCompleteness(100, {})).toEqual({ complete: true });
	});

	it("returns undefined when nothing is known (no upstream total, no DO verdict)", () => {
		expect(workspaceCompleteness(undefined, { row_count: 5 })).toBeUndefined();
	});

	// Nested-payload regression: row_count = parent + child rows, so comparing
	// upstreamTotal to row_count would wrongly report a partial page as complete.
	it("flags INCOMPLETE when primary_row_count < upstreamTotal even though total row_count >= upstreamTotal", () => {
		// 5 upstream records fetched (primary), 105 total rows incl. 100 child rows;
		// upstreamTotal=50 sits between primary (5) and total (105) → must be incomplete.
		expect(workspaceCompleteness(50, { row_count: 105, primary_row_count: 5 })).toEqual({
			complete: false,
			total_available: 50,
			returned: 105,
		});
	});

	it("uses primary_row_count (not inflated total row_count) as the pagination denominator", () => {
		// Without the fix, row_count(30) >= upstreamTotal(10) → wrongly complete.
		expect(workspaceCompleteness(10, { row_count: 30, primary_row_count: 3 })).toEqual({
			complete: false,
			total_available: 10,
			returned: 30,
		});
	});

	it("reports COMPLETE when every upstream record was fetched despite child rows inflating total", () => {
		expect(workspaceCompleteness(10, { row_count: 250, primary_row_count: 10 })).toEqual({
			complete: true,
		});
	});

	it("keeps materialization-incomplete independent of pagination (pagination-complete by primary, failed_rows still flags it)", () => {
		expect(
			workspaceCompleteness(5, {
				row_count: 5,
				primary_row_count: 5,
				completeness: { complete: false, failed_rows: 2 },
			}),
		).toEqual({ complete: false, total_available: 5, returned: 5 });
	});
});
