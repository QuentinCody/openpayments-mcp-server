import type { InferredColumn, InferredSchema, InferredTable } from "./schema-inference";

interface SchemaSql {
	exec(query: string): { toArray(): unknown[] };
}

/** Include the real columns of internal lossless tables in query validation. */
export function withPhysicalTables(schema: InferredSchema, sql: SchemaSql): InferredSchema {
	const known = new Set(schema.tables.map(table => table.name));
	const extra: InferredTable[] = [];
	try {
		const rows = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray() as Array<{ name?: unknown }>;
		for (const row of rows) {
			if (typeof row.name !== "string" || !row.name || known.has(row.name)) continue;
			const columns = sql.exec(`PRAGMA table_info("${row.name.replace(/"/g, '""')}")`).toArray() as Array<{ name: string; type: string }>;
			const inferred = columns.map((column): InferredColumn => ({ name: column.name,
				type: column.type === "INTEGER" || column.type === "REAL" || column.type === "JSON" ? column.type : "TEXT" }));
			extra.push({ name: row.name, columns: inferred, indexes: [] });
		}
	} catch {
		return schema; // Preserve existing behavior when physical metadata is unavailable.
	}
	return extra.length ? { tables: [...schema.tables, ...extra] } : schema;
}
