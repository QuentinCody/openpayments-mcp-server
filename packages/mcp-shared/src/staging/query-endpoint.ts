/**
 * Pure helpers for the staging DO's SQL query endpoints (`/query`,
 * `/query-enhanced`).
 *
 * Extracted from ./rest-staging-do.ts so the read-only guard, the cost bounds
 * and the COUNT(*) wrapper can be unit-tested without loading that module's
 * `cloudflare:workers` import — the same split as ./schema-hints.ts.
 *
 * Hardening doc 02: the read-only guard runs at THIS choke point (the DO's own
 * fetch routes), not per-tool, so a caller that reaches a staging DO directly
 * still cannot execute write/DDL SQL. 100+ servers extend RestStagingDO, so
 * this closes the endpoint fleet-wide.
 *
 * Hardening doc 03: the same choke point bounds a read-only SELECT's COST —
 * rows returned, result bytes, rows scanned, and the count_total scan.
 */

import type { TruncationReason } from "../completeness";
import {
	assertReadOnlySql,
	assertRecursiveHasLimit,
	MAX_COUNT_SCAN,
	MAX_RESULT_BYTES,
	MAX_RESULT_ROWS,
	MAX_ROWS_SCANNED,
} from "./sql-guard";
import { stripLineComments, stripTrailingSemicolons } from "./sql-lex";

export interface SqlQueryBody {
	sql: string;
	/** When true, also runs a COUNT(*) wrapper to report total matching rows */
	count_total?: boolean;
	/**
	 * Explicit, default-off opt-in for a genuinely-write internal caller
	 * (hardening doc 02). Absent/false = read-only enforced. Ships unused —
	 * all staging writes go through `/process`, and the DO's own metadata
	 * writes call `this.sql.exec` directly rather than this fetch route. It
	 * exists so a future internal writer has a sanctioned door instead of a
	 * new bypass. Deliberately NOT exposed through any public tool schema.
	 */
	allow_write?: boolean;
}

/** Coerce an unknown parsed JSON body into a `SqlQueryBody`. */
export function parseSqlQueryBody(raw: unknown): SqlQueryBody {
	return (
		raw !== null && typeof raw === "object" ? raw : { sql: "" }
	) as SqlQueryBody;
}

/**
 * UTF-8 byte length of a string, computed from char codes without allocating an
 * encoded copy (this runs per row inside the bounded pull, and a row can be
 * large). `Buffer` is not available in Workers; `TextEncoder.encode().length`
 * would allocate the whole byte array.
 */
export function byteLength(str: string): number {
	let bytes = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		const next = str.charCodeAt(i + 1);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			// A real high+low surrogate PAIR is one 4-byte code point.
			bytes += 4;
			i++;
		} else bytes += 3; // BMP char, OR a lone/unpaired surrogate (encodes as the
		// 3-byte replacement char — rs2 #8: don't assume every high surrogate is paired).
	}
	return bytes;
}

/** Strip a trailing LIMIT/OFFSET clause, trailing semicolon, and any code line
 *  comment so a query can be COUNT(*)-wrapped. */
export function stripLimit(sql: string): string {
	// Strip CODE comments first so a trailing `LIMIT 10 -- note` is found (rs2 #6),
	// then a trailing semicolon + whitespace so the COUNT(*) wrapper stays valid
	// (rs1 #12).
	const trimmed = stripTrailingSemicolons(stripLineComments(sql));
	// No leading-whitespace requirement, so a punctuation boundary like
	// `(SELECT 1)LIMIT 5` is matched (rs2 #6). `\bLIMIT` anchors to the word, so a
	// whitespace bomb with no LIMIT fails O(1) per position — no ReDoS (rs1 #8).
	// The legacy `LIMIT m, n` comma form is handled too (rs1 #12).
	return trimmed
		.replace(/\bLIMIT\s+-?\d+\s*(?:,\s*-?\d+\s*|OFFSET\s+-?\d+\s*)?$/i, "")
		.trimEnd();
}

export interface WriteBlockedError {
	success: false;
	error: string;
	code: "WRITE_SQL_BLOCKED";
}

export interface QueryCostError {
	success: false;
	error: string;
	code: "QUERY_COST_LIMIT";
}

/**
 * Read-only-by-default gate for the DO's query endpoints. Returns the error
 * body to serialize with HTTP 400, or null when the statement may proceed.
 *
 * Uses the canonical {@link assertReadOnlySql} — single statement, no
 * comments, no DDL/DML verbs, must start with SELECT/WITH, with the
 * `PRAGMA table_info(<table>)` describe explicitly allowed through.
 */
export function readOnlySqlError(body: SqlQueryBody): WriteBlockedError | null {
	if (body.allow_write === true) return null;
	try {
		assertReadOnlySql(body.sql);
		return null;
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : String(e),
			code: "WRITE_SQL_BLOCKED",
		};
	}
}

/**
 * Pre-flight cost gate (doc 03 §4): reject the one read shape that is
 * unbounded by construction — a `WITH RECURSIVE` with no LIMIT anywhere.
 *
 * Runs for EVERY statement, including the `allow_write` opt-in: doc 02's
 * escape hatch skips the read-only assertion, not the cost caps.
 *
 * The shared read path (`queryDataFromDo`) has already appended a LIMIT by the
 * time the SQL arrives here, so this only ever trips the legacy `_query_sql`
 * tools that POST raw caller SQL with no limit at all.
 */
export function queryCostError(body: SqlQueryBody): QueryCostError | null {
	try {
		assertRecursiveHasLimit(body.sql);
		return null;
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : String(e),
			code: "QUERY_COST_LIMIT",
		};
	}
}

/** The `SqlStorageCursor` surface the bounded pull needs. */
export interface PullCursor {
	next(): { done?: boolean; value?: Record<string, unknown> };
	/**
	 * Rows scanned so far. Optional because non-Cloudflare cursors (node:sqlite
	 * test doubles, the WorkspaceSql adapter) do not report it — when absent the
	 * scan cap simply does not apply and the row/byte caps still bound the pull.
	 */
	readonly rowsRead?: number;
}

export interface PullTruncation {
	reason: TruncationReason;
	detail: string;
}

export interface BoundedPull {
	rows: Record<string, unknown>[];
	/** The pull stopped before the cursor was exhausted. */
	truncated: boolean;
	truncation?: PullTruncation;
	/**
	 * Set when the scan budget blew. `rows` is empty — the caller MUST return
	 * the QUERY_COST_LIMIT error rather than the partial rows.
	 */
	cost_error?: string;
}

export interface PullLimits {
	maxRows?: number;
	maxBytes?: number;
	maxScan?: number;
}

/**
 * Materialize a cursor under the doc-03 cost bounds, replacing an unbounded
 * `cursor.toArray()`.
 *
 * Why incremental rather than toArray + slice: SQLite streams lazily, so
 * stopping early actually STOPS THE WORK. Measured on DO SQLite — an infinite
 * `WITH RECURSIVE` pulled 10 rows then abandoned returns in 0 ms, and a
 * 1,000,000-row CROSS JOIN abandoned at 5,000 scanned rows returns in 11 ms.
 * `toArray()` on either would run until the 30 s CPU limit.
 *
 * `rowsRead` is checked EVERY step, not just at the end: it accrues as the
 * cursor is consumed, so a mid-pull check aborts a lazily-streamed blow-up
 * while it is still cheap. An aggregate (`SELECT COUNT(*) ... CROSS JOIN`)
 * front-loads its whole scan into the first `next()`, so for that shape the
 * check is necessarily post-hoc — it converts an expensive response into a
 * bounded error, and the CPU limit remains the backstop for that one query.
 */
export function pullBoundedRows(
	cursor: PullCursor,
	limits: PullLimits = {},
): BoundedPull {
	const maxRows = limits.maxRows ?? MAX_RESULT_ROWS;
	const maxBytes = limits.maxBytes ?? MAX_RESULT_BYTES;
	const maxScan = limits.maxScan ?? MAX_ROWS_SCANNED;

	const rows: Record<string, unknown>[] = [];
	// Track the size of the SERIALIZED ARRAY, not the sum of the rows: the `[]`
	// and the `,` separators are ~1 byte/row, which at thousands of narrow rows
	// is kilobytes — enough to push a "capped" response back over the 100 KB
	// transport limit this cap exists to stay under.
	let bytes = 2;

	for (;;) {
		const step = cursor.next();
		const scanned = cursor.rowsRead;
		if (typeof scanned === "number" && scanned > maxScan) {
			return {
				rows: [],
				truncated: false,
				cost_error:
					`Query scanned ${scanned} rows (cap ${maxScan}) — far more than it returns. ` +
					"Add WHERE filters, join on an indexed column, or aggregate in SQL.",
			};
		}
		if (step.done === true || step.value === undefined) {
			return { rows, truncated: false };
		}
		// Pull one row PAST the cap so "the cursor had more" is knowable.
		if (rows.length >= maxRows) {
			return {
				rows: [],
				truncated: false,
				cost_error:
					`LOSSLESS_QUERY_RESULT_TOO_LARGE: complete result exceeds the ${maxRows}-row ` +
					"query ceiling. No partial rows were returned. Add an explicit LIMIT for an " +
					"intentional view, or aggregate/filter the query.",
			};
		}
		// UTF-8 BYTES, not UTF-16 units: the transport limit is in bytes, and
		// `.length` undercounts every multi-byte char, so a payload of emoji/CJK
		// rows sails past a cap it actually exceeds (rs1 #4). Same class as the
		// verify harness's structuredSize.
		const size = byteLength(JSON.stringify(step.value)) + (rows.length > 0 ? 1 : 0);
		if (bytes + size > maxBytes) {
			return {
				rows: [],
				truncated: false,
				cost_error:
					`LOSSLESS_QUERY_RESULT_TOO_LARGE: complete result exceeds the ${maxBytes}-byte ` +
					"query response ceiling. No partial rows were returned. Select fewer columns, " +
					"aggregate in SQL, or use an explicit bounded query.",
			};
		}
		rows.push(step.value);
		bytes += size;
	}
}

/** Explicit truncation signals from a pull, to spread into the response. */
export function pullSignals(pull: BoundedPull): {
	truncated?: true;
	truncation?: PullTruncation;
} {
	void pull;
	return {};
}

/** The minimal `SqlStorage.exec` surface the COUNT(*) wrapper needs. */
type ExecOne = (sql: string) => { one(): Record<string, unknown> | undefined };

export interface CountTotal {
	total_matching?: number;
	/** `total_matching` is a FLOOR, not an exact count — the scan hit the cap. */
	count_capped?: boolean;
}

/**
 * COUNT(*)-wrap the caller's query (LIMIT stripped) to report the true total.
 *
 * Bounded by an inner `LIMIT maxScan + 1` (doc 03 §3) so `count_total` can
 * never force a full scan of a huge staged table on demand: past the cap the
 * count is reported as "at least maxScan" with `count_capped: true`. Measured:
 * counting an infinite recursive CTE through this wrapper returns 100,000 in
 * 13 ms instead of running to the CPU limit.
 *
 * Best-effort: the wrapper errors on complex CTEs / duplicate column names, in
 * which case truncation is simply not reported (an empty object to spread).
 */
export function countTotal(
	exec: ExecOne,
	sql: string,
	rowCount: number,
	maxScan = MAX_COUNT_SCAN,
): CountTotal {
	try {
		const countResult = exec(
			`SELECT COUNT(*) as c FROM (${stripLimit(sql)} LIMIT ${maxScan + 1})`,
		).one();
		const counted = Number((countResult as { c: number })?.c ?? rowCount);
		const capped = counted > maxScan;
		const totalMatching = capped ? maxScan : counted;
		return {
			total_matching: totalMatching,
			...(capped ? { count_capped: true } : {}),
		};
	} catch {
		return {};
	}
}
