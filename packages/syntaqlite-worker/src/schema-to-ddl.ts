/**
 * Convert an InferredSchema (from staging pipeline) to CREATE TABLE DDL
 * suitable for syntaqlite's setSessionContextDdl().
 */

export interface InferredColumn {
	name: string;
	type: "TEXT" | "INTEGER" | "REAL" | "JSON";
	jsonShape?: string;
	pipeDelimited?: boolean;
}

export interface ChildTableRef {
	parentTable: string;
	fkColumn: string;
	sourceColumn: string;
}

export interface InferredTable {
	name: string;
	columns: InferredColumn[];
	indexes: string[];
	compositeIndexes?: string[][];
	childOf?: ChildTableRef;
}

export interface InferredSchema {
	tables: InferredTable[];
}

/** Escape a SQL identifier by doubling internal double-quotes. */
function escapeIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Map InferredColumn.type to SQLite column type. JSON maps to TEXT in SQLite. */
function sqliteType(type: InferredColumn["type"]): string {
	return type === "JSON" ? "TEXT" : type;
}

/**
 * Convert an InferredSchema to a string of CREATE TABLE statements.
 *
 * Mirrors the logic in schema-inference.ts `createTableAndIndexes()` so that
 * syntaqlite sees the same table/column names that SQLite will have at runtime.
 */
export function inferredSchemaToDdl(schema: InferredSchema): string {
	const statements: string[] = [];

	for (const table of schema.tables) {
		const hasIdColumn = table.columns.some((c) => c.name === "id");
		const autoIdCol = hasIdColumn
			? `_rowid INTEGER PRIMARY KEY AUTOINCREMENT`
			: `id INTEGER PRIMARY KEY AUTOINCREMENT`;

		const userCols = table.columns.map(
			(c) => `${escapeIdent(c.name)} ${sqliteType(c.type)}`,
		);

		const allCols = [autoIdCol, ...userCols].join(", ");
		statements.push(
			`CREATE TABLE IF NOT EXISTS ${escapeIdent(table.name)} (${allCols});`,
		);
	}

	return statements.join("\n");
}

/**
 * Build DDL from PRAGMA table_info() results.
 *
 * Used for DOs that don't store InferredSchema (e.g., clinicaltrialsgov).
 * Accepts the output of `PRAGMA table_info(tableName)` for each table.
 */
export function pragmaResultsToDdl(
	tables: Array<{
		name: string;
		columns: Array<{ name: string; type: string; pk: number }>;
	}>,
): string {
	const statements: string[] = [];

	for (const table of tables) {
		const cols = table.columns
			.map((c) => {
				const pkSuffix = c.pk ? " PRIMARY KEY" : "";
				return `${escapeIdent(c.name)} ${c.type || "TEXT"}${pkSuffix}`;
			})
			.join(", ");
		statements.push(
			`CREATE TABLE IF NOT EXISTS ${escapeIdent(table.name)} (${cols});`,
		);
	}

	return statements.join("\n");
}
