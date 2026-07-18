/**
 * Hardening doc 02 §3 — bounds on the by-design writer.
 *
 * `sql_exec` stays write-capable; these tests pin that it stays write-capable
 * (a small CREATE/INSERT still works) while the unbounded shapes are stopped.
 */

import { describe, expect, it, vi } from "vitest";
import type { SqlTaggedTemplate } from "../registry/types";
import {
	assertRecursiveHasLimit,
	assertUnderSizeCeiling,
	databaseSizeBytes,
	MAX_SCRATCH_DO_BYTES,
	MAX_WRITE_ROWS_PER_STMT,
	runBoundedWrite,
	type WriteGuardCtx,
} from "./sql-write-guard";

/** A tagged-template `ctx.sql` that records queries and answers PRAGMAs. */
function makeSql(pragma: { page_count?: number; page_size?: number } = {}) {
	const calls: string[] = [];
	const sql = (<T>(strings: TemplateStringsArray): T[] => {
		const query = strings.join("?");
		calls.push(query);
		if (query === "PRAGMA page_count") {
			return (
				pragma.page_count === undefined ? [] : [{ page_count: pragma.page_count }]
			) as T[];
		}
		if (query === "PRAGMA page_size") {
			return (
				pragma.page_size === undefined ? [] : [{ page_size: pragma.page_size }]
			) as T[];
		}
		return [{ ok: 1 }] as T[];
	}) as SqlTaggedTemplate;
	return { sql, calls };
}

/** A raw SqlStorage double with a settable databaseSize / rowsWritten. */
function makeStorage(opts: { databaseSize?: number; rowsWritten?: number } = {}) {
	const calls: string[] = [];
	const storage = {
		databaseSize: opts.databaseSize,
		exec: vi.fn((query: string) => {
			calls.push(query);
			return {
				toArray: () => [{ ok: 1 }],
				rowsWritten: opts.rowsWritten ?? 1,
			};
		}),
	};
	// SAFETY: the guard only reads `databaseSize` and calls `exec(...)`; this
	// double implements exactly that surface.
	return { storage: storage as unknown as SqlStorage, calls, raw: storage };
}

describe("assertRecursiveHasLimit", () => {
	it("rejects a WITH RECURSIVE with no LIMIT (the canonical unbounded write)", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
			),
		).toThrow(/recursive CTE is unbounded/i);
	});

	it("allows a WITH RECURSIVE that carries a LIMIT", () => {
		expect(() =>
			assertRecursiveHasLimit(
				"CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c LIMIT 100",
			),
		).not.toThrow();
	});

	it("ignores non-recursive statements", () => {
		expect(() => assertRecursiveHasLimit("CREATE TABLE t (a)")).not.toThrow();
		expect(() =>
			assertRecursiveHasLimit("WITH x AS (SELECT 1) SELECT * FROM x"),
		).not.toThrow();
	});
});

describe("databaseSizeBytes", () => {
	it("prefers the exact databaseSize when raw storage is plumbed", () => {
		const { sql } = makeSql();
		const { storage } = makeStorage({ databaseSize: 4096 });
		expect(databaseSizeBytes({ sql, sqlStorage: storage })).toBe(4096);
	});

	it("falls back to page_count x page_size without raw storage", () => {
		const { sql } = makeSql({ page_count: 10, page_size: 4096 });
		expect(databaseSizeBytes({ sql })).toBe(40960);
	});

	it("returns null when the size cannot be determined", () => {
		const { sql } = makeSql(); // PRAGMAs answer with no rows
		expect(databaseSizeBytes({ sql })).toBeNull();
	});

	it("returns null when reading the size throws", () => {
		const sql = (() => {
			throw new Error("no such pragma");
		}) as unknown as SqlTaggedTemplate;
		expect(databaseSizeBytes({ sql })).toBeNull();
	});
});

describe("assertUnderSizeCeiling", () => {
	it("rejects a write when the DO is at the ceiling", () => {
		const { sql } = makeSql();
		const { storage } = makeStorage({ databaseSize: MAX_SCRATCH_DO_BYTES });
		expect(() => assertUnderSizeCeiling({ sql, sqlStorage: storage })).toThrow(
			/ceiling/,
		);
	});

	it("allows a write below the ceiling", () => {
		const { sql } = makeSql();
		const { storage } = makeStorage({ databaseSize: 1024 });
		expect(() =>
			assertUnderSizeCeiling({ sql, sqlStorage: storage }),
		).not.toThrow();
	});

	it("stays out of the way when the size is unknown", () => {
		const { sql } = makeSql();
		expect(() => assertUnderSizeCeiling({ sql })).not.toThrow();
	});
});

describe("runBoundedWrite", () => {
	it("still executes a small CREATE TABLE (write-by-design is preserved)", () => {
		const { sql, calls } = makeSql({ page_count: 1, page_size: 4096 });
		const ctx: WriteGuardCtx = { sql };
		expect(runBoundedWrite(ctx, "CREATE TABLE t (a)")).toEqual([{ ok: 1 }]);
		expect(calls).toContain("CREATE TABLE t (a)");
	});

	it("still forwards parameters on an INSERT", () => {
		const { sql, calls } = makeSql();
		runBoundedWrite({ sql }, "INSERT INTO t VALUES (?)", ["x"]);
		expect(calls).toContain("INSERT INTO t VALUES (?)");
	});

	it("rejects a recursive CTE without LIMIT before touching sql", () => {
		const { sql, calls } = makeSql();
		expect(() =>
			runBoundedWrite(
				{ sql },
				"CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
			),
		).toThrow(/recursive CTE is unbounded/i);
		expect(calls).toEqual([]);
	});

	it("rejects a write when already at the size ceiling, without executing it", () => {
		const { sql } = makeSql();
		const { storage, calls } = makeStorage({
			databaseSize: MAX_SCRATCH_DO_BYTES + 1,
		});
		expect(() =>
			runBoundedWrite({ sql, sqlStorage: storage }, "CREATE TABLE t (a)"),
		).toThrow(/ceiling/);
		expect(calls).toEqual([]);
	});

	it("uses the raw storage when plumbed, and reports rows within the cap", () => {
		const { sql } = makeSql();
		const { storage, calls } = makeStorage({ databaseSize: 1024, rowsWritten: 5 });
		expect(
			runBoundedWrite({ sql, sqlStorage: storage }, "INSERT INTO t VALUES (1)"),
		).toEqual([{ ok: 1 }]);
		expect(calls).toEqual(["INSERT INTO t VALUES (1)"]);
	});

	it("rolls back a CREATE TABLE ... AS that blew past the rows cap", () => {
		const { sql } = makeSql();
		const { storage, calls } = makeStorage({
			databaseSize: 1024,
			rowsWritten: MAX_WRITE_ROWS_PER_STMT + 1,
		});
		expect(() =>
			runBoundedWrite(
				{ sql, sqlStorage: storage },
				"CREATE TABLE huge AS SELECT * FROM a, b",
			),
		).toThrow(/rolled back/);
		// The just-created table is dropped again.
		expect(calls).toContain('DROP TABLE IF EXISTS "huge"');
	});

	it("errors without a bogus DROP when an oversized write has no clean undo", () => {
		const { sql } = makeSql();
		const { storage, calls } = makeStorage({
			databaseSize: 1024,
			rowsWritten: MAX_WRITE_ROWS_PER_STMT + 1,
		});
		expect(() =>
			runBoundedWrite({ sql, sqlStorage: storage }, "INSERT INTO t SELECT * FROM a"),
		).toThrow(/per-statement cap/);
		expect(calls.some((c) => c.startsWith("DROP TABLE"))).toBe(false);
	});
});
