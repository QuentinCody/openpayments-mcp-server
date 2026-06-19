/**
 * Read-only SQL guard, shared by the per-dataset staging query path
 * (`queryDataFromDo`) and the workspace cross-dataset query surface
 * (`WorkspaceDO` `/ws/query`). One definition so the two cannot drift.
 *
 * This is defense-in-depth on top of read-only DO SQLite: a single statement,
 * no comments, no DDL/DML keywords, must start with SELECT or WITH.
 */

const DANGEROUS_KEYWORDS = [
	"DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE",
	"TRUNCATE", "REPLACE", "EXEC", "EXECUTE", "PRAGMA",
	"ATTACH", "DETACH", "REINDEX", "VACUUM", "ANALYZE",
];

/**
 * Validate that `sql` is a single read-only SELECT/WITH statement.
 * Returns the sanitized SQL (line comments stripped, trimmed) or throws with a
 * descriptive message. Does NOT append a LIMIT — see {@link applyDefaultLimit}.
 */
export function assertReadOnlySql(sql: string): string {
	const sanitizedSql = sql.replace(/--.*$/gm, "").trim();

	if (/\/\*/.test(sanitizedSql)) {
		throw new Error("C-style /* */ comments are not allowed");
	}
	if (sanitizedSql.split(";").filter(Boolean).length > 1) {
		throw new Error("Only single SQL statements are allowed");
	}

	const upperSql = sanitizedSql.toUpperCase();
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
	if (sql.toLowerCase().includes("limit")) return sql;
	return `${sql} LIMIT ${limit}`;
}

/** Strip a trailing `LIMIT n` so a query can be wrapped in `COUNT(*)`. */
export function stripTrailingLimit(sql: string): string {
	return sql.replace(/\s+limit\s+\d+\s*$/i, "");
}
