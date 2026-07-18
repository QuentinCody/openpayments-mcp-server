/**
 * Bounds for the by-design writer (`sql_exec` / `sql_exec_batch`) — hardening
 * doc 02 §3.
 *
 * These tools are write-by-design (schema scratch space for bio-orchestrator)
 * and STAY write-capable. The only goal here is that an anonymous caller — every
 * `/mcp` is unauthenticated (doc 00 §2) — cannot write unbounded gigabytes into
 * a billable Durable Object. Bound the tail, don't gate the call: no auth, and
 * a legitimate `CREATE TABLE` / `INSERT` under the ceiling behaves as before.
 *
 * Three bounds, cheapest first:
 *   1. shape — `WITH RECURSIVE` with no LIMIT is the canonical unbounded write
 *      (`CREATE TABLE t AS WITH RECURSIVE c(x) AS (...) SELECT x FROM c`).
 *      Rejected pre-flight, before a single row is written.
 *   2. size  — refuse any write once the DO is at/over the byte ceiling. This
 *      is the primary bound: it caps total storage regardless of statement shape.
 *   3. rows  — after the write, undo a statement that blew past the per-statement
 *      row cap. Secondary/belt-and-suspenders, and only possible when the raw
 *      `SqlStorage` is plumbed through (the tagged template cannot see
 *      `rowsWritten`).
 */

import type { SqlTaggedTemplate } from "../registry/types";
import { assertRecursiveHasLimit } from "../staging/sql-guard";
import { executeSql } from "./sql-helpers";

// Bound 1 lives in ../staging/sql-guard.ts so the write path (here) and the
// read path (staging/query-endpoint.ts, doc 03 §4) share ONE definition rather
// than two hand-maintained copies. Re-exported so this module's surface (and
// its tests) stay unchanged.
export { assertRecursiveHasLimit };

/**
 * DO-size ceiling for the orchestrator's scratch SQLite.
 *
 * Doc 01 (staging TTL & size caps) defines the staging-DO byte cap; when it
 * lands, the two should reconcile to one constant. Until then this is the
 * scratch-space limit and lives here.
 */
export const MAX_SCRATCH_DO_BYTES = 128 * 1024 * 1024;

/** Per-statement rows-written cap (see bound 3 above). */
export const MAX_WRITE_ROWS_PER_STMT = 1_000_000;

export type SqlParam = string | number | boolean | null;

/** The platform primitives the write bounds need. */
export interface WriteGuardCtx {
	sql: SqlTaggedTemplate;
	/**
	 * Raw Cloudflare `SqlStorage`. Optional: when absent the size gate falls
	 * back to `PRAGMA page_count` × `page_size` and the rows cap is skipped.
	 */
	sqlStorage?: SqlStorage;
}

/** `CREATE TABLE <name> AS <select>` — the one write shape with a clean undo. */
const CREATE_TABLE_AS_RE =
	/^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_]+)["'`\]]?\s+AS\b/i;

/** Read a single-value PRAGMA (`page_count` / `page_size`) as a number. */
function pragmaScalar(sql: SqlTaggedTemplate, pragma: string): number | null {
	const rows = executeSql<Record<string, unknown>>(sql, pragma);
	const first = rows[0];
	if (!first) return null;
	const value = Object.values(first)[0];
	return typeof value === "number" ? value : null;
}

/**
 * Current on-disk size of the DO's SQLite in bytes, or null when it cannot be
 * determined (in which case the size gate stays out of the way rather than
 * blocking a legitimate write).
 */
export function databaseSizeBytes(ctx: WriteGuardCtx): number | null {
	try {
		// Exact and O(1) when the raw storage is plumbed through.
		const exact = ctx.sqlStorage?.databaseSize;
		if (typeof exact === "number") return exact;
		// No-plumbing fallback — both are read-only PRAGMAs.
		const pageCount = pragmaScalar(ctx.sql, "PRAGMA page_count");
		const pageSize = pragmaScalar(ctx.sql, "PRAGMA page_size");
		if (pageCount === null || pageSize === null) return null;
		return pageCount * pageSize;
	} catch {
		return null;
	}
}

/** Bound 2 — refuse a write when the DO is already at/over the ceiling. */
export function assertUnderSizeCeiling(ctx: WriteGuardCtx): void {
	const size = databaseSizeBytes(ctx);
	if (size === null || size < MAX_SCRATCH_DO_BYTES) return;
	throw new Error(
		`Durable Object storage is ${size} bytes, at or over the ${MAX_SCRATCH_DO_BYTES}-byte ceiling. ` +
			"Drop unused scratch tables (sql_exec 'DROP TABLE ...') before writing more.",
	);
}

/**
 * Best-effort undo for bound 3. Only `CREATE TABLE <t> AS <select>` — the
 * canonical attack shape — has a well-defined undo; an oversized INSERT/UPDATE
 * cannot be reversed here, so its rows stand and bound 2 stops further growth.
 */
function undoOversizedWrite(storage: SqlStorage, query: string): void {
	const match = CREATE_TABLE_AS_RE.exec(query);
	if (!match) return;
	try {
		// SAFETY: not parameterizable — SQLite takes no bind parameter for an
		// identifier. Injection-free by construction: the table name is the
		// `[A-Za-z0-9_]+` capture of CREATE_TABLE_AS_RE, so it cannot contain a
		// quote, semicolon, or whitespace.
		storage.exec(`DROP TABLE IF EXISTS "${match[1]}"`);
	} catch {
		/* best-effort: the size ceiling remains the backstop */
	}
}

/**
 * Run a write statement under all three bounds. Returns the statement's rows
 * (matching `executeSql`'s contract) so callers keep their existing shape.
 *
 * `isBlocked` (ATTACH/DETACH/LOAD_EXTENSION + multi-statement) is the caller's
 * pre-existing check and still runs first — this adds the cost bounds only.
 */
export function runBoundedWrite(
	ctx: WriteGuardCtx,
	query: string,
	params?: SqlParam[],
): unknown {
	assertRecursiveHasLimit(query);
	assertUnderSizeCeiling(ctx);

	const storage = ctx.sqlStorage;
	if (!storage) {
		// Bounds 1 + 2 applied; rowsWritten is not observable without raw storage.
		return executeSql(ctx.sql, query, params);
	}

	const cursor = storage.exec(query, ...(params ?? []));
	const rows = cursor.toArray();
	const { rowsWritten } = cursor;
	if (typeof rowsWritten === "number" && rowsWritten > MAX_WRITE_ROWS_PER_STMT) {
		undoOversizedWrite(storage, query);
		throw new Error(
			`Statement wrote ${rowsWritten} rows, over the ${MAX_WRITE_ROWS_PER_STMT}-row per-statement cap; ` +
				"it was rolled back. Add a LIMIT or write in smaller batches.",
		);
	}
	return rows;
}
