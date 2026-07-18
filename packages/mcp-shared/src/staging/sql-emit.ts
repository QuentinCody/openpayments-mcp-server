/**
 * SQL value & identifier emission for the staging materializer. Extracted from
 * schema-inference.ts: this is the surface where arbitrary upstream JSON becomes
 * SQLite (values bound as parameters, keys quoted as identifiers), so it is the
 * value-coercion / injection surface and deserves its own tested module.
 */

/**
 * Convert a value for SQL insertion. Scalar arrays → pipe-delimited; objects and
 * object-arrays → JSON; null/undefined → null; boolean → 0/1; scalars → as-is.
 */
export function sqlValue(v: unknown): unknown {
	if (v === null || v === undefined) return null;
	if (Array.isArray(v)) {
		if (v.length === 0) return null;
		// Arrays containing objects → JSON.stringify to preserve structure
		// (prevents data loss from String({}) → "[object Object]").
		if (v.some((item) => item !== null && typeof item === "object")) {
			return JSON.stringify(v);
		}
		return v.map((item) => String(item)).join(" | "); // scalar array → pipe-delimited
	}
	if (typeof v === "object") return JSON.stringify(v);
	// SQLite's binder REJECTS a JS boolean (the INSERT throws and the row is
	// SILENTLY DROPPED). Store 0/1, SQLite's own convention. JSON has no bigint.
	if (typeof v === "boolean") return v ? 1 : 0;
	return v;
}

/** Quote a SQL identifier, escaping embedded double-quotes per the SQL standard. */
export function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Drop columns that collide case-insensitively, keeping the first.
 *
 * SQLite identifiers are case-insensitive, so `id` and `ID` are the SAME column —
 * emitting both made `CREATE TABLE` throw "duplicate column name" and lose the
 * ENTIRE table's data. Keeping the first is a bounded, no-crash outcome (the rare
 * second same-name-different-case field is dropped rather than crashing everything).
 */
export function dedupeColumnsByNameCI<T extends { name: string }>(columns: T[]): T[] {
	const seen = new Set<string>();
	return columns.filter((c) => {
		const key = c.name.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
