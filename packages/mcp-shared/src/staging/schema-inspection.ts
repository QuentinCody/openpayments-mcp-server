import { buildColumnDescriptor, type ColumnDescriptor, type ColumnMetaEntry } from "./schema-response";
import { quoteIdent } from "./sql-emit";

interface SchemaSql {
  exec(query: string): { toArray(): Record<string, unknown>[]; one(): Record<string, unknown> | undefined };
}

/** Inspect physical tables using quoted identifiers, including native child names. */
export function inspectStagedTables(
  sql: SchemaSql,
  columnMeta: Map<string, ColumnMetaEntry>,
  profileByTable: Map<string, Record<string, unknown>>,
) {
  const tables: Record<string, {row_count: number; columns: ColumnDescriptor[]}> = Object.create(null);
  let totalRows = 0;
  const names = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_staging_%' AND name NOT IN ('_inferred_schema', '_column_profiles')").toArray();
  for (const table of names) {
    const name = String(table.name);
    const identifier = quoteIdent(name);
    const columns = sql.exec(`PRAGMA table_info(${identifier})`).toArray();
    const count = sql.exec(`SELECT COUNT(*) as count FROM ${identifier}`).one();
    const rowCount = Number(count?.count ?? 0);
    totalRows += rowCount;
    tables[name] = { row_count: rowCount, columns: columns.map(column => buildColumnDescriptor(column, name, columnMeta, profileByTable)) };
  }
  return {tables, totalRows};
}
