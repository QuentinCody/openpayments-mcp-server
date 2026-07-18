import { describe, expect, it } from "vitest";
import {
	applyDefaultLimit,
	assertReadOnlySql,
	assertRecursiveHasLimit,
	clampLimit,
	MAX_RESULT_ROWS,
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

	it("allows a describe on a QUOTED name whose chars an identifier can't hold (rs1 #13)", () => {
		expect(assertReadOnlySql('PRAGMA table_info("gene-data")')).toBe('PRAGMA table_info("gene-data")');
		expect(assertReadOnlySql("PRAGMA table_info(`odd name`)")).toBe("PRAGMA table_info(`odd name`)");
	});

	it("allows a describe with a wide gap after PRAGMA (anchored regex is not bounded)", () => {
		const q = `PRAGMA${" ".repeat(30)}table_info(t)`;
		expect(assertReadOnlySql(q)).toBe(q);
	});

	it("still rejects other PRAGMAs and chained writes after a describe", () => {
		expect(() => assertReadOnlySql("PRAGMA writable_schema = ON")).toThrow(/PRAGMA/);
		expect(() => assertReadOnlySql("PRAGMA table_info(t); DROP TABLE t")).toThrow();
	});

	it("rejects a non-SELECT leading token", () => {
		expect(() => assertReadOnlySql("EXPLAIN SELECT 1")).toThrow(/SELECT\/WITH/);
	});

	// --- string-literal awareness (Codex rs1) ---

	it("SECURITY: a chained write hidden behind a -- inside a string is REJECTED (rs1 #1)", () => {
		// The bypass: the in-string -- once stripped "; DROP TABLE t", so the guard
		// saw only `SELECT '` and allowed it — then the DO executed the original.
		expect(() => assertReadOnlySql("SELECT '--'; DROP TABLE t")).toThrow(/single SQL statement/);
		expect(() => assertReadOnlySql("SELECT '--'; DELETE FROM t")).toThrow();
	});

	it("does NOT strip a -- that lives inside a string literal", () => {
		const sql = "SELECT note FROM t WHERE note = 'a -- b'";
		expect(assertReadOnlySql(sql)).toBe(sql);
	});

	it("accepts a SQL keyword that appears only inside a string literal (rs1 #11)", () => {
		expect(assertReadOnlySql("SELECT 'insert coin' AS msg")).toBe("SELECT 'insert coin' AS msg");
		expect(assertReadOnlySql("SELECT * FROM audit WHERE action = 'UPDATE'")).toBe(
			"SELECT * FROM audit WHERE action = 'UPDATE'",
		);
	});

	it("accepts a semicolon or block-comment marker inside a string (rs1 #11)", () => {
		expect(assertReadOnlySql("SELECT ';' AS x")).toBe("SELECT ';' AS x");
		expect(assertReadOnlySql("SELECT '/*' AS x")).toBe("SELECT '/*' AS x");
	});

	it("SECURITY: a chained write hidden in a [bracket] identifier is REJECTED (rs2 #1)", () => {
		// The `--` inside [x--y] is an identifier, not a comment; before bracket
		// support it stripped away the chained write and the guard passed it.
		expect(() => assertReadOnlySql("SELECT 1 AS [x--y]; DROP TABLE t")).toThrow(
			/single SQL statement/,
		);
	});

	it("accepts a describe on a doubled-quote-escaped table name (rs2 #7)", () => {
		expect(assertReadOnlySql('PRAGMA table_info("a""b")')).toBe('PRAGMA table_info("a""b")');
	});

	it("SECURITY: a doubled '' escape cannot smuggle a write past the guard", () => {
		// 'a''; DROP…' is NOT close-then-code — the '' is an escaped quote, so the
		// whole thing is one string and the statement is a plain (if odd) SELECT.
		// But a REAL second statement after a complete string is still caught:
		expect(() => assertReadOnlySql("SELECT 'a''b'; DROP TABLE t")).toThrow(/single SQL statement/);
	});

	it("does not exhibit ReDoS on a long semicolon run (rs1 #7 / rs2 #9)", () => {
		// The FAILING-suffix input is what made the old `/;+\s*$/` backtrack ~O(n^2)
		// (~5.6 s): a `;` run that does NOT end the string. A matching input (all
		// trailing `;`) ran fast even on the old regex, so it never tested the bug.
		const bomb = `SELECT 1 ${";".repeat(40000)}x`;
		const t0 = performance.now();
		// It is rejected (interior `;` => multi-statement); the point is it returns
		// FAST rather than hanging.
		expect(() => assertReadOnlySql(bomb)).toThrow();
		expect(performance.now() - t0).toBeLessThan(200);
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

	it("does not read a LIMIT inside a trailing comment as the bound (rs1 #9)", () => {
		// SQLite ignores the comment, so this query is UNBOUNDED — a real LIMIT
		// must be appended, not skipped because the regex saw `LIMIT 5` in a comment.
		expect(applyDefaultLimit("SELECT * FROM t -- LIMIT 5", 100)).toBe(
			"SELECT * FROM t LIMIT 100",
		);
	});

	it("rewrites `LIMIT -1` (SQLite: unbounded) down to the ceiling (rs1 #10)", () => {
		// The old regex matched only \d+, so `LIMIT -1` produced `LIMIT -1 LIMIT 100`
		// — invalid SQL. A negative limit is unbounded and must be capped.
		expect(applyDefaultLimit("SELECT * FROM t LIMIT -1", 100, 10_000)).toBe(
			"SELECT * FROM t LIMIT 10000",
		);
	});

	it("caps an over-ceiling LIMIT even with a wide gap before the number", () => {
		// The ReDoS fix must not bound the anchored whitespace: a bounded
		// quantifier failed to match >20 spaces and appended a second, invalid
		// LIMIT. The matched clause (spaces included) is replaced, so the gap
		// normalizes away — the point is that it CAPS rather than double-LIMITs.
		const q = `SELECT * FROM t LIMIT${" ".repeat(30)}999999`;
		expect(applyDefaultLimit(q, 100, 10_000)).toBe("SELECT * FROM t LIMIT 10000");
	});

	it("caps an over-ceiling LIMIT and preserves both OFFSET spellings", () => {
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 999999", 100, 10_000)).toBe(
			"SELECT * FROM t LIMIT 10000",
		);
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 999999 OFFSET 3", 100, 10_000)).toBe(
			"SELECT * FROM t LIMIT 10000 OFFSET 3",
		);
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 7, 999999", 100, 10_000)).toBe(
			"SELECT * FROM t LIMIT 7, 10000",
		);
	});
});

describe("assertRecursiveHasLimit (rs1 #2)", () => {
	it("throws on an unbounded recursive CTE", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("accepts a recursive CTE with a real LIMIT", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c LIMIT 100) SELECT x FROM c",
			),
		).not.toThrow();
	});

	it("SECURITY: does NOT accept a LIMIT that is only string data", () => {
		// `WHERE 'LIMIT'='LIMIT'` is not a bound — the recursion is still infinite.
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c WHERE 'LIMIT'='LIMIT'",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("catches recursion WITHOUT the RECURSIVE keyword (rs2 #2)", () => {
		// SQLite recurses after a plain WITH; a self-referential body + aggregate.
		expect(() =>
			assertRecursiveHasLimit(
				"WITH c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("does not read a commented LIMIT as a bound (rs2 #3)", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c -- LIMIT 1",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("rejects an AGGREGATE over the recursion despite an outer LIMIT (rs2 #4)", () => {
		// COUNT(*) consumes the whole infinite CTE before the outer LIMIT can act.
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c LIMIT 1",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("ALLOWS a plain streaming SELECT with an outer LIMIT (SQLite stops the lazy recursion)", () => {
		// Not an aggregate: `SELECT x FROM c LIMIT 100` pulls 100 rows then stops.
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c LIMIT 100",
			),
		).not.toThrow();
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

describe("clampLimit (doc 03 §1)", () => {
	it("clamps a caller limit above the ceiling down to it", () => {
		expect(clampLimit(10_000_000)).toBe(MAX_RESULT_ROWS);
		expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(MAX_RESULT_ROWS);
	});

	it("passes a limit under the ceiling through untouched", () => {
		expect(clampLimit(100)).toBe(100);
		expect(clampLimit(MAX_RESULT_ROWS)).toBe(MAX_RESULT_ROWS);
	});

	it("honors an explicit lower ceiling", () => {
		expect(clampLimit(1000, 50)).toBe(50);
	});

	it("treats a non-positive/non-numeric limit as 'none given' → the ceiling", () => {
		// The ceiling IS the enforced maximum; callers pick their own softer
		// default (`Number(args.limit) || 100`) before clamping.
		expect(clampLimit(0)).toBe(MAX_RESULT_ROWS);
		expect(clampLimit(-5)).toBe(MAX_RESULT_ROWS);
		expect(clampLimit(Number.NaN)).toBe(MAX_RESULT_ROWS);
	});

	it("truncates a fractional limit", () => {
		expect(clampLimit(10.9)).toBe(10);
	});
});

describe("applyDefaultLimit — cost ceiling (doc 03 §1)", () => {
	it("caps an absurd caller limit at the ceiling instead of trusting it", () => {
		expect(applyDefaultLimit("SELECT 1", 10_000_000)).toBe(
			`SELECT 1 LIMIT ${MAX_RESULT_ROWS}`,
		);
	});

	it("rewrites an in-SQL LIMIT above the ceiling DOWN to the ceiling", () => {
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 999999", 100)).toBe(
			`SELECT * FROM t LIMIT ${MAX_RESULT_ROWS}`,
		);
	});

	// Doc 03 §B: `includes("limit")` treated a LIMIT anywhere — including inside a
	// subquery — as "already bounded", so the OUTER query got no limit at all.
	it("still bounds the outer query when a subquery mentions LIMIT (closes §B)", () => {
		expect(
			applyDefaultLimit(
				"SELECT * FROM t WHERE x IN (SELECT y FROM u LIMIT 5)",
				100,
			),
		).toBe("SELECT * FROM t WHERE x IN (SELECT y FROM u LIMIT 5) LIMIT 100");
	});

	it("does not mistake a 'limit' inside a string literal for an outer bound", () => {
		expect(applyDefaultLimit("SELECT * FROM t WHERE note = 'limit 5'", 100)).toBe(
			"SELECT * FROM t WHERE note = 'limit 5' LIMIT 100",
		);
	});

	it("preserves OFFSET when rewriting an over-ceiling LIMIT down", () => {
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 999999 OFFSET 50", 100)).toBe(
			`SELECT * FROM t LIMIT ${MAX_RESULT_ROWS} OFFSET 50`,
		);
	});

	it("caps the legacy `LIMIT <offset>, <count>` form on its COUNT, not its offset", () => {
		// SQLite's offset-first spelling: the SECOND number is the row count.
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 20, 999999", 100)).toBe(
			`SELECT * FROM t LIMIT 20, ${MAX_RESULT_ROWS}`,
		);
		// Under the ceiling it must be left exactly alone (appending a second
		// LIMIT to this form is a SQLite syntax error).
		expect(applyDefaultLimit("SELECT * FROM t LIMIT 20, 5", 100)).toBe(
			"SELECT * FROM t LIMIT 20, 5",
		);
	});

	// T3.4 — the invariant the whole describe path depends on. Callers skip this
	// function for describes; this proves the ceiling can't break it if one slips.
	it("never appends a LIMIT to a PRAGMA table_info describe (T3.4)", () => {
		expect(applyDefaultLimit("PRAGMA table_info(studies)", 100)).toBe(
			"PRAGMA table_info(studies)",
		);
	});
});

describe("assertRecursiveHasLimit (doc 03 §4 / doc 02 §3 — one definition)", () => {
	it("rejects a WITH RECURSIVE with no LIMIT anywhere", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("allows a WITH RECURSIVE that carries a LIMIT", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c LIMIT 100",
			),
		).not.toThrow();
	});

	it("ignores a non-recursive CTE and a plain SELECT", () => {
		expect(() =>
			assertRecursiveHasLimit("WITH x AS (SELECT 1) SELECT * FROM x"),
		).not.toThrow();
		expect(() => assertRecursiveHasLimit("SELECT * FROM t")).not.toThrow();
	});
});
