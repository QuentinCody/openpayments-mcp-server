import { describe, expect, it } from "vitest";
import {
	applyDefaultLimit,
	assertReadOnlySql,
	stripTrailingLimit,
} from "./sql-guard";

describe("assertReadOnlySql", () => {
	it("accepts a plain SELECT and returns it trimmed", () => {
		expect(assertReadOnlySql("  SELECT * FROM t  ")).toBe("SELECT * FROM t");
	});

	it("accepts a WITH (CTE) query", () => {
		const sql = "WITH x AS (SELECT 1 AS n) SELECT n FROM x";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("accepts a cross-dataset JOIN", () => {
		const sql =
			"SELECT a.symbol FROM chembl__targets a JOIN dgidb__targets d ON a.symbol = d.symbol";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("strips line comments before validating", () => {
		expect(assertReadOnlySql("SELECT 1 -- DROP TABLE t")).toBe("SELECT 1");
	});

	it.each([
		"DROP",
		"DELETE",
		"INSERT",
		"UPDATE",
		"ALTER",
		"CREATE",
		"PRAGMA",
		"ATTACH",
		"VACUUM",
	])("rejects the %s keyword", (kw) => {
		expect(() => assertReadOnlySql(`${kw} something`)).toThrow();
	});

	it("does not false-positive on column names containing keywords", () => {
		// created_at / updated_at must not trip CREATE / UPDATE
		const sql = "SELECT created_at, updated_at FROM t";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("rejects multiple statements", () => {
		expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(
			/single SQL statement/,
		);
	});

	it("rejects C-style block comments", () => {
		expect(() => assertReadOnlySql("SELECT 1 /* sneaky */")).toThrow(
			/comments/,
		);
	});

	it("allows a read-only PRAGMA table_info(<table>) describe (T3.4)", () => {
		expect(assertReadOnlySql("PRAGMA table_info(studies)")).toBe("PRAGMA table_info(studies)");
		expect(assertReadOnlySql('  pragma table_info("nih_reporter_results") ;')).toBe('pragma table_info("nih_reporter_results")');
	});

	it("still rejects other PRAGMAs and chained writes after a describe", () => {
		expect(() => assertReadOnlySql("PRAGMA writable_schema = ON")).toThrow(/PRAGMA/);
		expect(() => assertReadOnlySql("PRAGMA table_info(t); DROP TABLE t")).toThrow();
	});

	it("rejects a non-SELECT leading token", () => {
		expect(() => assertReadOnlySql("EXPLAIN SELECT 1")).toThrow(/SELECT\/WITH/);
	});

	it("pre-flights SQLite's compound-SELECT term cap with a remedy (T5.2)", () => {
		const mega = `SELECT 1${" UNION SELECT 1".repeat(500)}`;
		expect(() => assertReadOnlySql(mega)).toThrow(/compound-SELECT terms/);
		// A modest number of UNIONs is fine.
		const ok = `SELECT 1${" UNION SELECT 1".repeat(10)}`;
		expect(assertReadOnlySql(ok)).toContain("UNION");
	});

	it("strips a trailing semicolon (so applyDefaultLimit can't form a 2nd statement)", () => {
		expect(assertReadOnlySql("SELECT * FROM t;")).toBe("SELECT * FROM t");
		expect(assertReadOnlySql("SELECT COUNT(*) FROM t ;  ")).toBe(
			"SELECT COUNT(*) FROM t",
		);
	});

	it("still rejects interior multiple statements even with a trailing semicolon", () => {
		expect(() => assertReadOnlySql("SELECT 1; SELECT 2;")).toThrow(
			/single SQL statement/,
		);
	});
});

describe("applyDefaultLimit", () => {
	it("appends a LIMIT when none is present", () => {
		expect(applyDefaultLimit("SELECT * FROM t", 50)).toBe(
			"SELECT * FROM t LIMIT 50",
		);
	});

	it("leaves an existing LIMIT untouched", () => {
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 5", 50)).toBe(
			"SELECT * FROM t LIMIT 5",
		);
	});

	it("strips a trailing semicolon before appending (regression: `; LIMIT` 2nd statement)", () => {
		expect(applyDefaultLimit("SELECT COUNT(*) FROM t;", 100)).toBe(
			"SELECT COUNT(*) FROM t LIMIT 100",
		);
	});

	it("composes with assertReadOnlySql on a semicolon-terminated query (the live bug)", () => {
		const userSql =
			"SELECT id FROM codemode_1_xry___data WHERE gene = 'GENE_3999';";
		expect(applyDefaultLimit(assertReadOnlySql(userSql), 100)).toBe(
			"SELECT id FROM codemode_1_xry___data WHERE gene = 'GENE_3999' LIMIT 100",
		);
	});
});

describe("stripTrailingLimit", () => {
	it("removes a trailing LIMIT for COUNT wrapping", () => {
		expect(stripTrailingLimit("SELECT * FROM t LIMIT 10")).toBe(
			"SELECT * FROM t",
		);
	});

	it("is a no-op without a trailing LIMIT", () => {
		expect(stripTrailingLimit("SELECT * FROM t")).toBe("SELECT * FROM t");
	});
});
