import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const projected = (value: Row, path: string): Row => ({
  ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_rowid").map(([key, cell]) =>
    [key, cell !== null && typeof cell === "object" ? JSON.stringify(cell) : cell])),
  native_json: JSON.stringify(value), source_path: path,
});

function rowTable(row: Row): string {
  if (["string", "number"].includes(typeof row.record_id) && ["string", "number"].includes(typeof row.program_year)) {
    if ("name_of_study" in row) return "research_payments";
    if ("total_amount_invested_usdollars" in row) return "ownership_payments";
    if ("total_amount_of_payment_usdollars" in row) return "payments";
  }
  // Uppercase avoids the shared detector treating this as a wrapper and hiding siblings.
  return "Results";
}

/** Preserve native envelopes and every row without coercing identifier/value strings. */
export function openpayTables(value: unknown) {
  const data = record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent
    ? value.structuredContent.data : value;
  const tables: Record<string, Row[]> = {};
  collect(data, "", tables, Array.isArray(data));
  splitWideTables(tables);
  tables.response_context = [{ native_json: JSON.stringify(data) ?? "null" }];
  return tables;
}

/** Workerd SQLite allows 100 columns including generated bookkeeping columns. */
function splitWideTables(tables: Record<string, Row[]>) {
  for (const [name, rows] of Object.entries(tables)) {
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(key => !["native_json", "source_path"].includes(key));
    if (keys.length <= 80) continue;
    for (let offset = 0; offset < keys.length; offset += 80) {
      const selected = keys.slice(offset, offset + 80);
      const table = offset === 0 ? name : `${name}_columns_${offset / 80 + 1}`;
      tables[table] = rows.map(row => ({
        ...Object.fromEntries(selected.filter(key => Object.prototype.hasOwnProperty.call(row, key)).map(key => [key, row[key]])),
        source_path: row.source_path,
        ...(offset === 0 ? { native_json: row.native_json } : {}),
      }));
    }
  }
}

function collect(value: unknown, path: string, tables: Record<string, Row[]>, rows = false) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => { collect(item, `${path}/${index}`, tables, rows); });
    return;
  }
  if (!record(value)) return;
  const kind = rowTable(value);
  const table = typeof value.identifier === "string" && typeof value.title === "string" && Array.isArray(value.distribution) ? "datasets"
    : rows || kind !== "Results" ? kind : undefined;
  if (table) {
    tables[table] ??= [];
    tables[table].push(projected(value, path));
    return;
  }
  if (typeof value.sql === "string" && Array.isArray(value.rows)) {
    tables.query_rows = value.rows.filter(record).map((item, index) => projected(item, `${path}/rows/${index}`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collect(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, tables, key === "results" && Array.isArray(child));
  }
}

export function openpaySchemaHints(value: unknown): SchemaHints {
  const columnTypes: Record<string, string> = { native_json: "TEXT", source_path: "TEXT" };
  for (const rows of Object.values(openpayTables(value))) for (const row of rows) {
    for (const [key, cell] of Object.entries(row)) if (typeof cell === "string") columnTypes[key] = "TEXT";
  }
  return { columnTypes };
}
