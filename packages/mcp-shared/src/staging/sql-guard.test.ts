import { describe, expect, it } from "vitest";
import { applyDefaultLimit, assertReadOnlySql, stripTrailingLimit } from "./sql-guard";

describe("assertReadOnlySql", () => {
	it("accepts a plain SELECT and returns it trimmed", () => {
		expect(assertReadOnlySql("  SELECT * FROM t  ")).toBe("SELECT * FROM t");
	});

	it("accepts a WITH (CTE) query", () => {
		const sql = "WITH x AS (SELECT 1 AS n) SELECT n FROM x";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("accepts a cross-dataset JOIN", () => {
		const sql = "SELECT a.symbol FROM chembl__targets a JOIN dgidb__targets d ON a.symbol = d.symbol";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("strips line comments before validating", () => {
		expect(assertReadOnlySql("SELECT 1 -- DROP TABLE t")).toBe("SELECT 1");
	});

	it.each(["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "PRAGMA", "ATTACH", "VACUUM"])(
		"rejects the %s keyword",
		(kw) => {
			expect(() => assertReadOnlySql(`${kw} something`)).toThrow();
		},
	);

	it("does not false-positive on column names containing keywords", () => {
		// created_at / updated_at must not trip CREATE / UPDATE
		const sql = "SELECT created_at, updated_at FROM t";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("rejects multiple statements", () => {
		expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(/single SQL statement/);
	});

	it("rejects C-style block comments", () => {
		expect(() => assertReadOnlySql("SELECT 1 /* sneaky */")).toThrow(/comments/);
	});

	it("rejects a non-SELECT leading token", () => {
		expect(() => assertReadOnlySql("EXPLAIN SELECT 1")).toThrow(/SELECT\/WITH/);
	});
});

describe("applyDefaultLimit", () => {
	it("appends a LIMIT when none is present", () => {
		expect(applyDefaultLimit("SELECT * FROM t", 50)).toBe("SELECT * FROM t LIMIT 50");
	});

	it("leaves an existing LIMIT untouched", () => {
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 5", 50)).toBe("SELECT * FROM t LIMIT 5");
	});
});

describe("stripTrailingLimit", () => {
	it("removes a trailing LIMIT for COUNT wrapping", () => {
		expect(stripTrailingLimit("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t");
	});

	it("is a no-op without a trailing LIMIT", () => {
		expect(stripTrailingLimit("SELECT * FROM t")).toBe("SELECT * FROM t");
	});
});
