import { describe, expect, it } from "vitest";
import {
	ensureIdColumn,
	MAX_TABLE_COLUMNS,
	resolveColumnTypes,
} from "./normalizer";

const typesOf = (cols: Record<string, string>): Record<string, Set<string>> => {
	const out: Record<string, Set<string>> = {};
	for (const [k, v] of Object.entries(cols)) out[k] = new Set([v]);
	return out;
};

describe("resolveColumnTypes", () => {
	it("collapses a single observed type to that type", () => {
		expect(resolveColumnTypes(typesOf({ a: "INTEGER", b: "TEXT" }))).toEqual({
			a: "INTEGER",
			b: "TEXT",
		});
	});

	it("prefers TEXT > REAL > INTEGER on mixed types", () => {
		expect(
			resolveColumnTypes({ a: new Set(["INTEGER", "TEXT"]) }),
		).toEqual({ a: "TEXT" });
		expect(resolveColumnTypes({ a: new Set(["INTEGER", "REAL"]) })).toEqual({
			a: "REAL",
		});
	});

	it("leaves a normal-width table untouched (no _overflow_json)", () => {
		const wide: Record<string, Set<string>> = {};
		for (let i = 0; i < 50; i++) wide[`c${i}`] = new Set(["TEXT"]);
		const cols = resolveColumnTypes(wide);
		expect(Object.keys(cols)).toHaveLength(50);
		expect(cols._overflow_json).toBeUndefined();
	});

	it("T5.1/T5.3: caps a too-wide table and spills into _overflow_json", () => {
		const wide: Record<string, Set<string>> = {};
		for (let i = 0; i < MAX_TABLE_COLUMNS + 75; i++) {
			wide[`c${i}`] = new Set(["TEXT"]);
		}
		const cols = resolveColumnTypes(wide);
		// Never exceeds the cap, and always carries the overflow column.
		expect(Object.keys(cols).length).toBeLessThanOrEqual(MAX_TABLE_COLUMNS);
		expect(cols._overflow_json).toBe("TEXT");
		// The kept columns are a prefix of the originals (deterministic).
		expect(cols.c0).toBe("TEXT");
	});
});

describe("ensureIdColumn (regression guard alongside the cap)", () => {
	it("adds an autoincrement id when absent", () => {
		const cols: Record<string, string> = { name: "TEXT" };
		ensureIdColumn(cols);
		expect(cols.id).toBe("INTEGER PRIMARY KEY AUTOINCREMENT");
	});
});
