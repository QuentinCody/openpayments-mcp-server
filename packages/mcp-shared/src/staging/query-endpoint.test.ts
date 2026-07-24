import { describe, expect, it } from "vitest";
import {
	byteLength,
	countTotal,
	parseSqlQueryBody,
	pullBoundedRows,
	pullSignals,
	queryCostError,
	readOnlySqlError,
	stripLimit,
} from "./query-endpoint";
import { MAX_COUNT_SCAN } from "./sql-guard";

describe("byteLength", () => {
	it("counts ASCII as one byte each", () => {
		expect(byteLength("abc")).toBe(3);
		expect(byteLength("")).toBe(0);
	});

	it("counts multi-byte UTF-8 correctly (the rs1 #4 undercount)", () => {
		// "😀" is 4 UTF-8 bytes but String.length === 2 (a surrogate pair).
		expect(byteLength("😀")).toBe(4);
		expect("😀".length).toBe(2); // the wrong measure the cap used to use
		expect(byteLength("é")).toBe(2); // 2-byte
		expect(byteLength("中")).toBe(3); // 3-byte
		expect(byteLength("a中😀")).toBe(1 + 3 + 4);
	});

	it("agrees with TextEncoder for a mixed string", () => {
		const s = 'x"中"😀y';
		expect(byteLength(s)).toBe(new TextEncoder().encode(s).length);
	});

	it("counts a LONE high surrogate as 3 bytes, not 4 (rs2 #8)", () => {
		// A high surrogate with no following low surrogate encodes as the 3-byte
		// replacement char. The old code assumed every high surrogate was paired.
		const lone = "\uD800中";
		expect(byteLength(lone)).toBe(new TextEncoder().encode(lone).length);
		expect(byteLength(lone)).toBe(6); // 3 (lone) + 3 (中)
	});
});

/**
 * A stand-in for Cloudflare's `SqlStorageCursor`, matching the semantics
 * MEASURED on real DO SQLite (workerd, `wrangler dev`):
 *   - `rowsRead` accrues AS the cursor is consumed (a 1,000-row scan reports 1
 *     after the first next(), 1,000 after the last) — so a mid-pull check can
 *     abort a streaming blow-up early.
 *   - an aggregate (`SELECT COUNT(*) ... CROSS JOIN`) front-loads its ENTIRE
 *     scan into the first next(), so `rowsRead` is already huge by then and the
 *     check is necessarily post-hoc.
 */
function makeCursor(
	rows: Record<string, unknown>[],
	opts: { scanPerRow?: number; frontLoadedScan?: number } = {},
) {
	let i = 0;
	let rowsRead = 0;
	let nextCalls = 0;
	return {
		next() {
			nextCalls++;
			if (opts.frontLoadedScan !== undefined && i === 0) {
				rowsRead = opts.frontLoadedScan;
			}
			if (i >= rows.length) return { done: true as const };
			const value = rows[i++];
			if (opts.frontLoadedScan === undefined) rowsRead += opts.scanPerRow ?? 1;
			return { done: false as const, value };
		},
		get rowsRead() {
			return rowsRead;
		},
		/** How many times next() was pulled — proves the cap aborts EARLY (rs2 #10). */
		get nextCalls() {
			return nextCalls;
		},
		/** The pre-doc-03 materialization path, kept to characterize it. */
		toArray() {
			return rows;
		},
	};
}

const rowsOf = (n: number): Record<string, unknown>[] =>
	Array.from({ length: n }, (_, i) => ({ id: i }));

describe("pullBoundedRows (doc 03 §2)", () => {
	it("returns every row unchanged when under all ceilings", () => {
		const pull = pullBoundedRows(makeCursor(rowsOf(3)));
		expect(pull.rows).toHaveLength(3);
		expect(pull.truncated).toBe(false);
		expect(pull.cost_error).toBeUndefined();
	});

	// The pre-change handler called `res.toArray()`: whatever the cursor held all
	// landed in the response. This pins that the cap is what now bounds it.
	it("rejects the whole pull at the row ceiling", () => {
		expect(makeCursor(rowsOf(50_000)).toArray()).toHaveLength(50_000); // pre-doc-03
		const pull = pullBoundedRows(makeCursor(rowsOf(50_000)), { maxRows: 10 });
		expect(pull.rows).toEqual([]);
		expect(pull.truncated).toBe(false);
		expect(pull.cost_error).toMatch(/No partial rows were returned/);
	});

	it("does not flag truncation when the cursor holds exactly the ceiling", () => {
		const pull = pullBoundedRows(makeCursor(rowsOf(10)), { maxRows: 10 });
		expect(pull.rows).toHaveLength(10);
		expect(pull.truncated).toBe(false);
	});

	it("rejects the whole pull at the byte ceiling", () => {
		const wide = Array.from({ length: 100 }, () => ({ blob: "x".repeat(100) }));
		const pull = pullBoundedRows(makeCursor(wide), { maxBytes: 500 });
		expect(pull.rows).toEqual([]);
		expect(pull.truncated).toBe(false);
		expect(pull.cost_error).toMatch(/No partial rows were returned/);
	});

	it("measures the byte ceiling in UTF-8 BYTES, not UTF-16 units (rs1 #4)", () => {
		// Each row is 4 UTF-8 bytes of emoji but String.length counts it as 2, so
		// the old cap admitted roughly twice the bytes it should. Assert the real
		// UTF-8 size of what came back stays within the ceiling.
		const rows = Array.from({ length: 200 }, () => ({ e: "😀".repeat(20) }));
		const pull = pullBoundedRows(makeCursor(rows), { maxBytes: 2_000 });
		expect(pull.rows).toEqual([]);
		expect(pull.cost_error).toMatch(/complete result exceeds/);
	});

	// Regression: the budget must measure the SERIALIZED ARRAY. Summing only the
	// rows ignores the `[]` + `,` framing (~1 byte/row), which at thousands of
	// narrow rows silently overshot by kilobytes — enough to push a "capped"
	// response back over the 100 KB transport limit the cap exists to respect.
	it("counts the JSON array framing, not just the rows", () => {
		const pull = pullBoundedRows(makeCursor(rowsOf(10_000)), {
			maxBytes: 1_000,
		});
		expect(pull.rows).toEqual([]);
		expect(pull.cost_error).toMatch(/complete result exceeds/);
	});

	// The adversarial shape: an aggregate over a CROSS JOIN returns ONE row but
	// scans N² (measured: rowsRead 1,001,000 for a 1,000-row table). An outer
	// LIMIT cannot stop it — only the scan budget can.
	it("returns QUERY_COST_LIMIT for an aggregate scanning far more than it returns", () => {
		const pull = pullBoundedRows(
			makeCursor(rowsOf(1), { frontLoadedScan: 1_001_000 }),
			{ maxScan: 5_000 },
		);
		expect(pull.cost_error).toMatch(/scanned 1001000 rows \(cap 5000\)/);
		expect(pull.rows).toEqual([]);
	});

	it("aborts a lazily-streamed blow-up mid-pull, not after it completes (rs2 #10)", () => {
		// 1,000 rows available, each scanning 100 → the budget blows at ~50 rows.
		const cursor = makeCursor(rowsOf(1_000), { scanPerRow: 100 });
		const pull = pullBoundedRows(cursor, { maxScan: 5_000 });
		expect(pull.cost_error).toBeDefined();
		expect(pull.rows).toEqual([]);
		// The whole point of a scan CAP is that it stops EARLY — an eager impl that
		// drains all 1,001 steps before checking rowsRead would also produce the
		// error, so assert it pulled far fewer than the 1,000 available rows.
		expect(cursor.nextCalls).toBeLessThan(100);
	});

	it("leaves a normal query untouched when the scan is within budget", () => {
		const pull = pullBoundedRows(makeCursor(rowsOf(5), { scanPerRow: 10 }));
		expect(pull.rows).toHaveLength(5);
		expect(pull.cost_error).toBeUndefined();
	});

	it("skips the scan cap for a cursor that does not report rowsRead", () => {
		let i = 0;
		const rows = rowsOf(3);
		const cursor = {
			next: () =>
				i >= rows.length
					? { done: true as const }
					: { done: false as const, value: rows[i++] },
		};
		const pull = pullBoundedRows(cursor, { maxScan: 1 });
		expect(pull.rows).toHaveLength(3);
		expect(pull.cost_error).toBeUndefined();
	});
});

describe("pullSignals", () => {
	it("emits nothing for an untruncated pull, so a COUNT verdict stands", () => {
		expect(pullSignals({ rows: [], truncated: false })).toEqual({});
	});

	it("never emits a partial-result signal", () => {
		expect(
			pullSignals({
				rows: [],
				truncated: true,
				truncation: { reason: "row_limit", detail: "d" },
			}),
		).toEqual({});
	});
});

describe("queryCostError (doc 03 §4)", () => {
	it("rejects an unbounded recursive CTE read with QUERY_COST_LIMIT", () => {
		expect(
			queryCostError({
				sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
			}),
		).toMatchObject({ success: false, code: "QUERY_COST_LIMIT" });
	});

	it("allows the same CTE once it carries a LIMIT", () => {
		expect(
			queryCostError({
				sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c LIMIT 10",
			}),
		).toBeNull();
	});

	it("allows an ordinary SELECT", () => {
		expect(queryCostError({ sql: "SELECT * FROM t" })).toBeNull();
	});

	// doc 02's allow_write skips the READ-ONLY assertion, not the cost caps.
	it("still cost-bounds a statement using the allow_write opt-in", () => {
		expect(
			queryCostError({
				sql: "CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
				allow_write: true,
			}),
		).toMatchObject({ code: "QUERY_COST_LIMIT" });
	});
});

describe("countTotal — cost cap (doc 03 §3)", () => {
	it("bounds the COUNT wrapper with an inner LIMIT of the scan cap + 1", () => {
		let seen = "";
		const exec = (sql: string) => {
			seen = sql;
			return { one: () => ({ c: 5 }) as never };
		};
		countTotal(exec, "SELECT * FROM t LIMIT 10", 10);
		expect(seen).toBe(
			`SELECT COUNT(*) as c FROM (SELECT * FROM t LIMIT ${MAX_COUNT_SCAN + 1})`,
		);
	});

	it("reports a capped count as a floor with count_capped, not an exact total", () => {
		const exec = () => ({ one: () => ({ c: MAX_COUNT_SCAN + 1 }) as never });
		expect(countTotal(exec, "SELECT * FROM huge", 100)).toEqual({
			total_matching: MAX_COUNT_SCAN,
			count_capped: true,
		});
	});

	it("does not flag count_capped for a total exactly at the cap", () => {
		const exec = () => ({ one: () => ({ c: MAX_COUNT_SCAN }) as never });
		expect(countTotal(exec, "SELECT * FROM t", 10)).toEqual({
			total_matching: MAX_COUNT_SCAN,
		});
	});
});

describe("parseSqlQueryBody", () => {
	it("passes an object body through", () => {
		expect(parseSqlQueryBody({ sql: "SELECT 1", count_total: true })).toEqual({
			sql: "SELECT 1",
			count_total: true,
		});
	});

	it.each([null, "a string", 42, undefined])(
		"falls back to an empty sql for the non-object body %p",
		(raw) => {
			expect(parseSqlQueryBody(raw)).toEqual({ sql: "" });
		},
	);
});

describe("stripLimit", () => {
	it("removes a trailing LIMIT and LIMIT/OFFSET", () => {
		expect(stripLimit("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t");
		expect(stripLimit("SELECT * FROM t LIMIT 10 OFFSET 5")).toBe(
			"SELECT * FROM t",
		);
	});

	it("is a no-op without a trailing LIMIT", () => {
		expect(stripLimit("SELECT * FROM t")).toBe("SELECT * FROM t");
	});

	it("strips the legacy `LIMIT m, n` comma form (rs1 #12)", () => {
		// Left in place, `... LIMIT 20, 5 LIMIT 100001` is invalid inside the COUNT wrapper.
		expect(stripLimit("SELECT * FROM t LIMIT 20, 5")).toBe("SELECT * FROM t");
	});

	it("strips a trailing semicolon so the COUNT wrapper stays valid (rs1 #12)", () => {
		expect(stripLimit("SELECT * FROM t;")).toBe("SELECT * FROM t");
	});

	it("strips a LIMIT at a punctuation boundary — no whitespace before it (rs2 #6)", () => {
		expect(stripLimit("SELECT * FROM (SELECT 1)LIMIT 5")).toBe("SELECT * FROM (SELECT 1)");
	});

	it("strips a LIMIT followed by a trailing code comment (rs2 #6)", () => {
		expect(stripLimit("SELECT * FROM t LIMIT 10 -- comment")).toBe("SELECT * FROM t");
	});

	it("does not exhibit ReDoS on a long whitespace run (rs1 #8)", () => {
		const bomb = `SELECT${" ".repeat(40000)}1`;
		const t0 = performance.now();
		stripLimit(bomb);
		expect(performance.now() - t0).toBeLessThan(200);
	});
});

describe("readOnlySqlError", () => {
	it("SECURITY: blocks a write hidden behind a comment-in-string (rs1 #1)", () => {
		const e = readOnlySqlError({ sql: "SELECT '--'; DROP TABLE t" });
		expect(e?.code).toBe("WRITE_SQL_BLOCKED");
	});

	it("allows a plain SELECT", () => {
		expect(readOnlySqlError({ sql: "SELECT * FROM t" })).toBeNull();
	});

	it("allows a WITH CTE and a PRAGMA table_info describe", () => {
		expect(
			readOnlySqlError({ sql: "WITH x AS (SELECT 1 AS n) SELECT n FROM x" }),
		).toBeNull();
		expect(readOnlySqlError({ sql: "PRAGMA table_info(studies)" })).toBeNull();
	});

	// The adversarial case from hardening doc 02: an anonymous caller filling a
	// billable DO with a recursive CTE materialized into a permanent table.
	it("blocks the recursive-CTE CREATE TABLE (doc 02 adversarial case)", () => {
		const attack =
			"CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c";
		expect(readOnlySqlError({ sql: attack })).toEqual({
			success: false,
			error: expect.stringMatching(/CREATE/),
			code: "WRITE_SQL_BLOCKED",
		});
	});

	it.each(["DROP TABLE t", "INSERT INTO t VALUES (1)", "DELETE FROM t"])(
		"blocks %s with the WRITE_SQL_BLOCKED code",
		(sql) => {
			expect(readOnlySqlError({ sql })).toMatchObject({
				success: false,
				code: "WRITE_SQL_BLOCKED",
			});
		},
	);

	it("blocks a multi-statement write chained after a SELECT", () => {
		expect(readOnlySqlError({ sql: "SELECT 1; DROP TABLE t" })).toMatchObject({
			code: "WRITE_SQL_BLOCKED",
		});
	});

	it("permits a write only under the explicit allow_write opt-in", () => {
		expect(
			readOnlySqlError({ sql: "CREATE TABLE t (a)", allow_write: true }),
		).toBeNull();
	});

	it("does not treat a truthy-but-not-true allow_write as an opt-in", () => {
		// Guards against a JSON body smuggling `allow_write: "true"` past a
		// loose check; the gate is strict `=== true`.
		expect(
			readOnlySqlError({
				sql: "DROP TABLE t",
				allow_write: "true" as unknown as boolean,
			}),
		).toMatchObject({ code: "WRITE_SQL_BLOCKED" });
	});
});

describe("countTotal", () => {
	const execWith = (c: unknown) => () => ({ one: () => ({ c }) as never });

	it("reports the total without reclassifying an intentional SQL view", () => {
		expect(countTotal(execWith(42), "SELECT * FROM t LIMIT 10", 10)).toEqual({
			total_matching: 42,
		});
	});

	it("does not flag truncation when the page holds every row", () => {
		expect(countTotal(execWith(3), "SELECT * FROM t", 3)).toEqual({
			total_matching: 3,
		});
	});

	it("returns an empty object when the COUNT wrapper throws (complex CTE)", () => {
		const exec = () => {
			throw new Error("duplicate column name");
		};
		expect(countTotal(exec, "WITH a AS (SELECT 1) SELECT * FROM a", 1)).toEqual(
			{},
		);
	});

	it("falls back to the row count when the wrapper returns no count", () => {
		const exec = () => ({ one: () => undefined });
		expect(countTotal(exec, "SELECT * FROM t", 7)).toEqual({
			total_matching: 7,
		});
	});
});
