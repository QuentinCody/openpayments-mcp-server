/**
 * Read-only SQL guard, shared by the per-dataset staging query path
 * (`queryDataFromDo`) and the workspace cross-dataset query surface
 * (`WorkspaceDO` `/ws/query`). One definition so the two cannot drift.
 *
 * This is defense-in-depth on top of read-only DO SQLite: a single statement,
 * no comments, no DDL/DML keywords, must start with SELECT or WITH.
 */

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
const READONLY_DESCRIBE_RE = /^pragma\s+table_info\s*\(\s*["'`]?[A-Za-z0-9_]+["'`]?\s*\)$/i;

/** True for a `PRAGMA table_info(<table>)` read-only describe (T3.4). */
export function isReadOnlyDescribe(sql: string): boolean {
	return READONLY_DESCRIBE_RE.test(sql.replace(/;+\s*$/, "").trim());
}

/**
 * Validate that `sql` is a single read-only SELECT/WITH statement.
 * Returns the sanitized SQL (line comments stripped, trimmed) or throws with a
 * descriptive message. Does NOT append a LIMIT — see {@link applyDefaultLimit}.
 */
export function assertReadOnlySql(sql: string): string {
	// Strip line comments, then a single trailing `;` (+ surrounding whitespace).
	// Leaving the `;` breaks `applyDefaultLimit`, which would append a second
	// statement (`SELECT ...; LIMIT 100` → SQLite "near LIMIT" syntax error).
	// The multi-statement check below still rejects *interior* semicolons.
	const sanitizedSql = sql
		.replace(/--.*$/gm, "")
		.trim()
		.replace(/;+\s*$/, "")
		.trim();

	if (/\/\*/.test(sanitizedSql)) {
		throw new Error("C-style /* */ comments are not allowed");
	}
	if (sanitizedSql.split(";").filter(Boolean).length > 1) {
		throw new Error("Only single SQL statements are allowed");
	}

	// T3.4 — read-only describe path: allow PRAGMA table_info(<table>) so column
	// discovery works without tripping the SELECT-only / no-PRAGMA rules below.
	if (isReadOnlyDescribe(sanitizedSql)) return sanitizedSql;

	const upperSql = sanitizedSql.toUpperCase();

	// T5.2 — pre-flight SQLite's compound-SELECT term cap (~500 UNION/INTERSECT/
	// EXCEPT terms) so a model-authored mega-UNION fails HERE with a clear remedy
	// instead of a raw "too many terms in compound SELECT: SQLITE_ERROR" mid-query.
	const compoundTerms = (upperSql.match(/\b(UNION|INTERSECT|EXCEPT)\b/g) ?? []).length;
	if (compoundTerms > 450) {
		throw new Error(
			`Query has ${compoundTerms} compound-SELECT terms (UNION/INTERSECT/EXCEPT) — SQLite caps these near 500. ` +
				`Split into batches of <450 and combine in code, or use WHERE ... IN (...) / a JOIN instead.`,
		);
	}
	for (const keyword of DANGEROUS_KEYWORDS) {
		// Word-boundary regex avoids false positives on column names like
		// "created_at" matching CREATE or "updated_at" matching UPDATE.
		const regex = new RegExp(`\\b${keyword}\\b`);
		if (regex.test(upperSql)) {
			throw new Error(
				`SQL command '${keyword}' is not allowed. Only SELECT queries are permitted.`,
			);
		}
	}

	if (!/^\s*(SELECT|WITH)\b/i.test(sanitizedSql)) {
		throw new Error("Only SELECT/WITH queries are allowed");
	}

	return sanitizedSql;
}

/** Append a default `LIMIT` if the (already-sanitized) query has none. */
export function applyDefaultLimit(sql: string, limit: number): string {
	// Defensive: strip a trailing `;` so the appended LIMIT can't become a
	// second statement, even if a caller passes un-sanitized SQL.
	const trimmed = sql.replace(/;+\s*$/, "").trimEnd();
	if (trimmed.toLowerCase().includes("limit")) return trimmed;
	return `${trimmed} LIMIT ${limit}`;
}

/** Strip a trailing `LIMIT n` so a query can be wrapped in `COUNT(*)`. */
export function stripTrailingLimit(sql: string): string {
	return sql.replace(/\s+limit\s+\d+\s*$/i, "");
}
