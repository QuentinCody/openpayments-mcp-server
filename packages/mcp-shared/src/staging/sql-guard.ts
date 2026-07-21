/**
 * Read-only SQL guard, shared by the per-dataset staging query path
 * (`queryDataFromDo`) and the workspace cross-dataset query surface
 * (`WorkspaceDO` `/ws/query`). One definition so the two cannot drift.
 *
 * This is defense-in-depth on top of read-only DO SQLite: a single statement,
 * no comments, no DDL/DML keywords, must start with SELECT or WITH.
 */

import {
	blankQuotedLiterals,
	stripLineComments,
	stripTrailingSemicolons,
} from "./sql-lex";

const DANGEROUS_KEYWORDS = [
	"DROP",
	"DELETE",
	"INSERT",
	"UPDATE",
	"ALTER",
	"CREATE",
	"TRUNCATE",
	"REPLACE",
	"EXEC",
	"EXECUTE",
	"PRAGMA",
	"ATTACH",
	"DETACH",
	"REINDEX",
	"VACUUM",
	"ANALYZE",
];

/**
 * Read-only describe form allowed despite the SELECT-only default (T3.4): a
 * `PRAGMA table_info(<table>)` lets a model that just staged data learn a
 * table's columns. `table_info` is purely read-only (no other PRAGMA matches).
 */
// Table name is either a bare identifier (letters/digits/underscore) OR a
// QUOTED name, whose whole point is to permit characters an identifier cannot,
// so a quoted name allows anything but its own closing quote (rs1 #13:
// PRAGMA table_info("gene-data") is valid and read-only). Whitespace stays
// unbounded: this regex is anchored ^...$ with a single start and no
// overlapping quantifiers, so it is linear (no ReDoS), and bounding it would
// falsely reject a pretty-printed describe with 21+ spaces.
// Quoted-name alternatives use the "unrolled" form `"[^"]*(?:""[^"]*)*"` so a
// doubled-quote escape (rs2 #7: `table_info("a""b")`) is accepted, with no
// nested-quantifier backtracking. `[bracket]` names allowed too.
const READONLY_DESCRIBE_RE =
	/^pragma\s+table_info\s*\(\s*(?:"[^"]*(?:""[^"]*)*"|'[^']*(?:''[^']*)*'|`[^`]*(?:``[^`]*)*`|\[[^\]]+\]|[A-Za-z0-9_]+)\s*\)$/i;

/** True for a `PRAGMA table_info(<table>)` read-only describe (T3.4). */
export function isReadOnlyDescribe(sql: string): boolean {
	return READONLY_DESCRIBE_RE.test(stripTrailingSemicolons(sql).trim());
}

/**
 * Validate that `sql` is a single read-only SELECT/WITH statement.
 * Returns the sanitized SQL (line comments stripped, trimmed) or throws with a
 * descriptive message. Does NOT append a LIMIT — see {@link applyDefaultLimit}.
 */
export function assertReadOnlySql(sql: string): string {
	// Sanitize string-aware: strip CODE line comments, then a trailing
	// semicolon + whitespace. A dash-dash inside a string is DATA, not a
	// comment; a raw dash-dash-to-end-of-line strip turned
	// "SELECT '--'; DROP TABLE t" into "SELECT '", hiding the chained write so
	// the guard passed it and the DO ran the original (rs1 #1). The linear
	// semicolon strip replaces a regex that was O(n^2) on a long semicolon run,
	// about 8.5 s for 40k, a per-request CPU-exhaustion vector (rs1 #7).
	const sanitizedSql = stripTrailingSemicolons(
		stripLineComments(sql).trim(),
	).trim();

	// The checks below classify CODE: is this a write, a second statement, a
	// block comment. Run them on a projection with quoted CONTENTS blanked, so a
	// keyword / semicolon / block-marker INSIDE a string is not read as code:
	// "SELECT 'insert coin'", "SELECT ';'", "SELECT '/*'" are read-only (rs1 #11).
	// blankQuotedLiterals preserves length, so positions still align.
	const code = blankQuotedLiterals(sanitizedSql);

	if (/\/\*/.test(code)) {
		throw new Error("C-style /* */ comments are not allowed");
	}
	if (code.split(";").filter(Boolean).length > 1) {
		throw new Error("Only single SQL statements are allowed");
	}

	// T3.4 — read-only describe path: allow PRAGMA table_info(<table>) so column
	// discovery works without tripping the SELECT-only / no-PRAGMA rules below.
	if (isReadOnlyDescribe(sanitizedSql)) return sanitizedSql;

	const upperCode = code.toUpperCase();

	// T5.2 — pre-flight SQLite's compound-SELECT term cap (~500 UNION/INTERSECT/
	// EXCEPT terms) so a model-authored mega-UNION fails HERE with a clear remedy
	// instead of a raw "too many terms in compound SELECT: SQLITE_ERROR" mid-query.
	const compoundTerms = (upperCode.match(/\b(UNION|INTERSECT|EXCEPT)\b/g) ?? [])
		.length;
	if (compoundTerms > 450) {
		throw new Error(
			`Query has ${compoundTerms} compound-SELECT terms (UNION/INTERSECT/EXCEPT) — SQLite caps these near 500. ` +
				`Split into batches of <450 and combine in code, or use WHERE ... IN (...) / a JOIN instead.`,
		);
	}
	for (const keyword of DANGEROUS_KEYWORDS) {
		// Word-boundary regex avoids false positives on column names like
		// "created_at" matching CREATE or "updated_at" matching UPDATE. The
		// `(?!\s*\()` lookahead additionally lets a scalar FUNCTION call of the
		// same name through: `REPLACE(col, ',', '')` is SQLite's string function,
		// not the `REPLACE INTO` write statement. No dangerous SQLite statement is
		// ever spelled `KEYWORD(` — they are `REPLACE INTO`, `DROP TABLE`,
		// `DELETE FROM`, `PRAGMA name`, … (keyword + space + identifier) — so this
		// relaxes only the scalar-function case and opens no write bypass. The
		// single-statement (above) and SELECT/WITH-start (below) checks still hold.
		const regex = new RegExp(`\\b${keyword}\\b(?!\\s*\\()`);
		if (regex.test(upperCode)) {
			throw new Error(
				`SQL command '${keyword}' is not allowed. Only SELECT queries are permitted.`,
			);
		}
	}

	if (!/^\s*(SELECT|WITH)\b/i.test(code)) {
		throw new Error("Only SELECT/WITH queries are allowed");
	}

	return sanitizedSql;
}

/* ── Cost ceilings (hardening doc 03) ──────────────────────────────────────
 *
 * One source of truth for every read-cost bound, so raising a cap that proves
 * too tight is a one-line change. All four are set ABOVE real query needs: a
 * normal `SELECT ... LIMIT 100` is byte-for-byte unaffected.
 */

/** Hard ceiling on rows RETURNED by one query (matches the servers' Zod `.max(10000)`). */
export const MAX_RESULT_ROWS = 10_000;

/**
 * Byte ceiling on a returned result set (~96 KB) — just under the 100 KB at
 * which MCP Streamable HTTP silently drops the response. This cap does not lose
 * data that survives today; it makes an existing silent drop explicit.
 */
export const MAX_RESULT_BYTES = 96 * 1024;

/**
 * Budget for rows SCANNED (`SqlStorageCursor.rowsRead`), not rows returned.
 *
 * Measured on DO SQLite (workerd, local `wrangler dev`) against a 1,000-row
 * table — `rowsRead` does count rows consumed by INNER scans, which is what
 * makes this cap enforceable at all:
 *   SELECT * FROM t LIMIT 1                             -> rowsRead             1
 *   SELECT * FROM t                                     -> rowsRead         1,000
 *   SELECT COUNT(*) FROM t CROSS JOIN t                 -> rowsRead     1,001,000  (7 ms)
 *   SELECT COUNT(*) FROM t CROSS JOIN t CROSS JOIN t    -> rowsRead 1,001,001,000  (7.3 s)
 *
 * 5 M is roughly 40 ms of scan on that hardware — far above any legitimate
 * staged query, far below the 30 s CPU limit that is otherwise the only ceiling.
 */
export const MAX_ROWS_SCANNED = 5_000_000;

/**
 * `count_total` scan budget. Beyond this the count is reported as a floor
 * ("at least N") with `count_capped: true` rather than scanning a whole table
 * to produce an exact number on demand.
 */
export const MAX_COUNT_SCAN = 100_000;

/**
 * Clamp a caller-supplied row limit to a hard ceiling.
 *
 * A limit that is absent/garbage (NaN, <= 0, Infinity) means "no valid limit
 * given" and yields the ceiling — the ceiling IS the enforced maximum, and
 * callers pick their own softer default (`Number(args.limit) || 100`) before
 * clamping. This can only ever LOWER what a caller asked for.
 */
export function clampLimit(limit: number, ceiling = MAX_RESULT_ROWS): number {
	if (!Number.isFinite(limit) || limit < 1) return ceiling;
	return Math.min(Math.trunc(limit), ceiling);
}

/**
 * A trailing outer `LIMIT`, in either SQLite spelling:
 *   `LIMIT n` / `LIMIT n OFFSET m` / `LIMIT m, n` (legacy offset-first form).
 *
 * Anchored to `$` so a `LIMIT` inside a subquery does NOT count as the outer
 * bound. The old `includes("limit")` test treated one as if it did, so
 * `SELECT ... WHERE x IN (SELECT y FROM t LIMIT 5)` got no outer limit at all
 * (doc 03 §B).
 */
// Matches a trailing outer LIMIT in either SQLite spelling. The count is
// captured as an OPTIONALLY-SIGNED integer: SQLite reads a negative LIMIT as
// "unbounded", so it must be recognized (not left for a second LIMIT to be
// appended after it, which is invalid SQL, rs1 #10). Whitespace is unbounded:
// the regex is anchored at the single word LIMIT and ends at $, with no
// overlapping quantifiers, so it is linear (no ReDoS) — and a bounded quantifier
// would fail to cap a pretty-printed "LIMIT<many spaces>999999", producing a
// double LIMIT. Detection runs on a projection with quoted contents blanked, so
// a lowercase "limit" inside a trailing string is not mistaken for the bound.
const TRAILING_LIMIT_RE =
	/\blimit\s+(-?\d+)\s*(?:,\s*(-?\d+)\s*|offset\s+(-?\d+)\s*)?$/i;

/** Rewrite a matched trailing LIMIT down to `ceiling`, preserving any OFFSET. */
function cappedLimitClause(match: RegExpExecArray, ceiling: number): string {
	const [, first, commaCount, offset] = match;
	// `LIMIT <offset>, <count>` — the count is the SECOND number.
	if (commaCount !== undefined) return `LIMIT ${first}, ${ceiling}`;
	if (offset !== undefined) return `LIMIT ${ceiling} OFFSET ${offset}`;
	return `LIMIT ${ceiling}`;
}

/**
 * Bound the outer query by `limit`, never exceeding `ceiling` (doc 03 §1).
 *
 * - No trailing LIMIT -> append `LIMIT clampLimit(limit, ceiling)`.
 * - Trailing LIMIT over the ceiling, or negative (SQLite = unbounded) -> rewrite
 *   it DOWN to the ceiling.
 * - Trailing LIMIT within [0, ceiling] -> left exactly as the caller wrote it.
 */
export function applyDefaultLimit(
	sql: string,
	limit: number,
	ceiling = MAX_RESULT_ROWS,
): string {
	// String-aware sanitize: a trailing CODE line comment must not carry a
	// phantom `LIMIT` (`SELECT * FROM t -- LIMIT 5` is unbounded — SQLite ignores
	// the comment — yet the bare regex saw the commented LIMIT as the bound and
	// appended nothing, rs1 #9). Strip code comments and trailing semicolons.
	const trimmed = stripTrailingSemicolons(stripLineComments(sql).trimEnd()).trimEnd();
	if (isReadOnlyDescribe(trimmed)) return trimmed;

	// Detect the trailing LIMIT on the blanked projection (so a `limit` inside a
	// trailing string literal is not matched); rewrite the ORIGINAL at the same
	// index, since blanking preserves length.
	const blanked = blankQuotedLiterals(trimmed);
	const match = TRAILING_LIMIT_RE.exec(blanked);
	if (!match) {
		// A trailing LIMIT whose operand is an EXPRESSION (LIMIT 1+1, a subquery)
		// will not match the integer recognizer. Appending a second LIMIT would be
		// invalid SQL (rs2 #5), so leave the caller's clause — the DO row/byte/scan
		// caps still bound the actual result. The pattern below means an OUTER
		// trailing LIMIT (no closing paren before end), not one inside a subquery.
		if (/\bLIMIT\b[^)]*$/i.test(blanked)) return trimmed;
		return `${trimmed} LIMIT ${clampLimit(limit, ceiling)}`;
	}

	const current = Number(match[2] ?? match[1]);
	if (current >= 0 && current <= ceiling) return trimmed;
	return trimmed.slice(0, match.index) + cappedLimitClause(match, ceiling);
}

/** Index of the `)` matching the `(` at `openIdx`, or -1. Assumes string-blanked
 *  input, so parens inside literals are already neutralized. */
function matchParenEnd(s: string, openIdx: number): number {
	let depth = 0;
	for (let k = openIdx; k < s.length; k++) {
		if (s[k] === "(") depth++;
		else if (s[k] === ")") {
			depth--;
			if (depth === 0) return k;
		}
	}
	return -1;
}

/** Each CTE's `{ name, body }` from a WITH clause, on comment-stripped,
 *  string-blanked code. `body` is the text inside its `AS ( ... )`. */
function extractCteDefinitions(
	code: string,
): Array<{ name: string; body: string }> {
	const defs: Array<{ name: string; body: string }> = [];
	const withHead = /\bWITH\s+(?:RECURSIVE\s+)?/i.exec(code);
	if (!withHead) return defs;
	let i = withHead.index + withHead[0].length;
	for (;;) {
		// <name> [(<cols>)] AS (
		const head = /^\s*["`[]?([A-Za-z_]\w*)["`\]]?\s*(?:\([^()]*\)\s*)?AS\s*\(/i.exec(
			code.slice(i),
		);
		if (!head) break;
		const openParen = i + head[0].length - 1;
		const end = matchParenEnd(code, openParen);
		if (end < 0) break;
		defs.push({ name: head[1], body: code.slice(openParen + 1, end) });
		i = end + 1;
		const comma = /^\s*,/.exec(code.slice(i));
		if (!comma) break;
		i += comma[0].length;
	}
	return defs;
}

/** Aggregate / full-materialization functions: each consumes its WHOLE input
 *  before yielding a row, so an OUTER limit cannot bound a recursion feeding it. */
const AGGREGATE_RE = /\b(?:COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT)\s*\(/i;

/** Whether the query OUTSIDE the CTE bodies aggregates and/or carries a LIMIT.
 *  A plain streaming `SELECT ... FROM cte LIMIT n` is bounded (SQLite stops the
 *  lazy recursion at n rows); an aggregate forces the whole recursion (rs2 #4). */
function analyzeOuterQuery(
	code: string,
	defs: Array<{ name: string; body: string }>,
): { aggregates: boolean; hasLimit: boolean } {
	let outer = code;
	for (const { body } of defs) {
		outer = outer.replace(body, " ".repeat(body.length));
	}
	return {
		aggregates: AGGREGATE_RE.test(outer),
		hasLimit: /\bLIMIT\b/i.test(outer),
	};
}

/** A CTE is recursive when it FROM/JOINs its own name inside its body. */
function isRecursiveCte(name: string, body: string): boolean {
	return new RegExp(`\\b(?:FROM|JOIN)\\s+["\`[]?${name}\\b`, "i").test(body);
}

export function assertRecursiveHasLimit(query: string): void {
	// Comment- AND string-aware: a `-- LIMIT` comment or a `'LIMIT'` string is not
	// a bound (rs1 #2, rs2 #3). SQLite allows recursion after a plain `WITH`, no
	// RECURSIVE keyword (rs2 #2).
	const code = blankQuotedLiterals(stripLineComments(query));
	if (!/\bWITH\b/i.test(code)) return;
	const defs = extractCteDefinitions(code);
	const outer = analyzeOuterQuery(code, defs);
	const unbounded = outer.aggregates || !outer.hasLimit;

	for (const { name, body } of defs) {
		if (!isRecursiveCte(name, body) || /\bLIMIT\b/i.test(body)) continue;
		if (unbounded) {
			throw new Error(
				"A recursive CTE is unbounded here — an aggregate consumes the whole " +
					"recursion (an outer LIMIT cannot stop it), or there is no LIMIT at all, " +
					"which can fill the Durable Object. Add a LIMIT inside the recursive CTE, " +
					"or query it with a plain (non-aggregating) SELECT ... LIMIT n.",
			);
		}
	}
}

/** Strip a trailing `LIMIT n` so a query can be wrapped in `COUNT(*)`. */
export function stripTrailingLimit(sql: string): string {
	// Only the LEADING separator is bounded `\s{1,20}` — it is the unanchored
	// ReDoS vector (it can start at any position). The whitespace after LIMIT and
	// before the digit is anchored by the rest of the pattern, so it stays `\s+`.
	return sql.replace(/\s{1,20}limit\s+-?\d+\s*$/i, "");
}
