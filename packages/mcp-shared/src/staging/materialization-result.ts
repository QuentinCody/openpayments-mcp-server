import { inferSchema, type MaterializationResult, type SchemaHints } from "./schema-inference";

export function prepareMaterialization(arrays: Array<{ key: string; rows: unknown[] }>, hints: SchemaHints | undefined, replace: boolean) {
  const schema = inferSchema(arrays, hints);
  if (replace && (schema.tables.length !== arrays.length || schema.tables.some(table => !arrays.some(array => array.key === table.name)))) throw new Error("Replacement schema must match the submitted table names");
  const rowsMap = new Map<string, unknown[]>();
  for (const array of arrays) {
    const name = hints?.tableName ?? array.key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const actual = schema.tables.length === 1 ? schema.tables[0].name : schema.tables.find(table => table.name === name)?.name ?? name;
    rowsMap.set(actual, array.rows);
  }
  return { schema, rowsMap };
}

export function materializationWarnings(result: MaterializationResult): Record<string, unknown> {
  const warnings: Record<string, unknown> = {};
  if (result.failedRows > 0) {
    warnings.rows_skipped = result.failedRows;
    warnings.sample_errors = result.warnings.map(value => ({ row: value.rowIndex, table: value.table, error: value.error }));
  }
  const lossPercent = result.inputRows > 0 ? (result.failedRows / result.inputRows) * 100 : 0;
  if (lossPercent > 5) warnings.data_loss_warning =
    `${result.failedRows} of ${result.inputRows} rows (${lossPercent.toFixed(1)}%) failed to stage. ` +
    "This exceeds the 5% threshold. Review sample_errors for details.";
  return warnings;
}
