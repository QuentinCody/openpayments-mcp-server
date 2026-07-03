import { describe, expect, it } from "vitest";
import { autoDetectKey, type KeyColumnStat } from "./key-detect";

const stat = (
	column: string,
	distinctCount: number,
	nullCount: number,
	rowCount: number,
): KeyColumnStat => ({
	column,
	distinctCount,
	nullCount,
	rowCount,
});

describe("autoDetectKey", () => {
	it("picks a unique, non-null column", () => {
		expect(
			autoDetectKey([stat("name", 3, 0, 5), stat("nct_id", 5, 0, 5)]),
		).toEqual(["nct_id"]);
	});
	it("prefers a known bio-id name over another unique column", () => {
		expect(
			autoDetectKey([stat("foo", 5, 0, 5), stat("rsid", 5, 0, 5)]),
		).toEqual(["rsid"]);
	});
	it("never returns the staging synthetic _rowid", () => {
		expect(autoDetectKey([stat("_rowid", 5, 0, 5)])).toBeNull();
	});
	it("returns null when no column is a clean unique key", () => {
		expect(autoDetectKey([stat("a", 3, 0, 5), stat("b", 5, 1, 5)])).toBeNull();
	});
});
