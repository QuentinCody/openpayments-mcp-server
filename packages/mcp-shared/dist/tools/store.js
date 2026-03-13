/**
 * Structured data storage tool for V8 isolates.
 *
 * Provides a `__store` hidden tool that accepts a table name + array of flat
 * objects, infers schema, creates/evolves the table, and batch-inserts rows.
 * Returns a small summary instead of the full dataset, keeping context window
 * usage minimal.
 *
 * Security layers:
 *   1. Table name validation (identifier regex, deny list, reserved prefixes)
 *   2. Column name validation (same identifier rules)
 *   3. Value type enforcement (scalars only — nested objects rejected with hints)
 *   4. Row/column count limits
 */
import { z } from "zod";
import { executeSql } from "./sql-helpers";
import { DENIED_TABLES } from "./direct-query";
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 200;
const INSERT_BATCH_SIZE = 500;
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const BLOCKED_TABLE_PREFIXES = ["sqlite_", "_cf_"];
function validateTableName(table) {
    if (typeof table !== "string" || table.length === 0) {
        return {
            error: "Table name is required",
            error_code: "INVALID_TABLE_NAME",
            hint: "Provide a non-empty string as the table name.",
        };
    }
    if (table.length > 64) {
        return {
            error: `Table name exceeds 64 characters: "${table.slice(0, 20)}..."`,
            error_code: "INVALID_TABLE_NAME",
            hint: "Use a shorter table name (max 64 characters).",
        };
    }
    if (!IDENTIFIER_RE.test(table)) {
        return {
            error: `Invalid table name: "${table}"`,
            error_code: "INVALID_TABLE_NAME",
            hint: "Table names must start with a letter or underscore, followed by letters, digits, or underscores. No spaces or special characters.",
        };
    }
    const lower = table.toLowerCase();
    for (const prefix of BLOCKED_TABLE_PREFIXES) {
        if (lower.startsWith(prefix)) {
            return {
                error: `Table name "${table}" uses reserved prefix "${prefix}"`,
                error_code: "INVALID_TABLE_NAME",
                hint: `Choose a table name that doesn't start with "${prefix}".`,
            };
        }
    }
    if (DENIED_TABLES.has(lower)) {
        return {
            error: `Access denied to table: ${table}`,
            error_code: "INVALID_TABLE_NAME",
            hint: "This is a system table and cannot be written to.",
        };
    }
    return null;
}
function validateData(data) {
    if (!Array.isArray(data)) {
        return {
            error: "Data must be an array of objects",
            error_code: "INVALID_DATA",
            hint: "Pass an array of plain objects, e.g. [{ id: 1, name: 'Alice' }].",
        };
    }
    if (data.length === 0) {
        return {
            error: "Data array is empty",
            error_code: "INVALID_DATA",
            hint: "Provide at least one row.",
        };
    }
    if (data.length > MAX_ROWS) {
        return {
            error: `Too many rows: ${data.length} (max ${MAX_ROWS})`,
            error_code: "TOO_MANY_ROWS",
            hint: `Split data into batches of ${MAX_ROWS} rows or fewer.`,
        };
    }
    // Validate each row is a plain object
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
            return {
                error: `Row ${i} is not a plain object`,
                error_code: "INVALID_DATA",
                hint: "Every element in the data array must be a plain object { key: value }.",
                details: [{ row: i, value_type: row === null ? "null" : Array.isArray(row) ? "array" : typeof row }],
            };
        }
    }
    return null;
}
function validateColumnsAndValues(data) {
    // Collect all keys across all rows
    const allKeys = new Set();
    for (const row of data) {
        for (const key of Object.keys(row)) {
            allKeys.add(key);
        }
    }
    if (allKeys.size === 0) {
        return {
            error: "No columns found — all rows are empty objects",
            error_code: "NO_COLUMNS",
            hint: "Each row must have at least one key, e.g. [{ id: 1 }].",
        };
    }
    if (allKeys.size > MAX_COLUMNS) {
        return {
            error: `Too many columns: ${allKeys.size} (max ${MAX_COLUMNS})`,
            error_code: "TOO_MANY_COLUMNS",
            hint: `Reduce the number of unique keys across all rows to ${MAX_COLUMNS} or fewer.`,
        };
    }
    // Validate column names
    for (const key of allKeys) {
        if (!IDENTIFIER_RE.test(key)) {
            return {
                error: `Invalid column name: "${key}"`,
                error_code: "INVALID_COLUMN_NAME",
                hint: "Column names must start with a letter or underscore, followed by letters, digits, or underscores. Rename the key before storing.",
            };
        }
    }
    // Validate values are scalars — reject nested objects/arrays with hints
    const nestedKeys = [];
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        for (const [key, value] of Object.entries(row)) {
            if (value !== null && typeof value === "object") {
                nestedKeys.push({
                    row: i,
                    key,
                    value_type: Array.isArray(value) ? "array" : "object",
                });
            }
        }
    }
    if (nestedKeys.length > 0) {
        const uniqueKeys = [...new Set(nestedKeys.map((n) => n.key))];
        return {
            error: `Found nested objects/arrays in keys: ${uniqueKeys.join(", ")}`,
            error_code: "NESTED_VALUES",
            hint: "Options:\n" +
                "1. JSON.stringify() the nested values before storing\n" +
                '2. Flatten: { "address_city": obj.address.city }\n' +
                "3. Store nested data in a separate table with a foreign key",
            details: nestedKeys.slice(0, 10),
        };
    }
    return null;
}
function inferSqliteType(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "boolean")
        return "INTEGER"; // booleans → 0/1
    if (typeof value === "number")
        return Number.isInteger(value) ? "INTEGER" : "REAL";
    return "TEXT"; // strings and everything else
}
function inferColumnTypes(data) {
    const types = new Map();
    // Collect all keys, sorted alphabetically for determinism
    const allKeys = new Set();
    for (const row of data) {
        for (const key of Object.keys(row)) {
            allKeys.add(key);
        }
    }
    const sortedKeys = [...allKeys].sort();
    for (const key of sortedKeys) {
        let inferred = null;
        for (const row of data) {
            const value = row[key];
            const t = inferSqliteType(value);
            if (t === null)
                continue; // skip nulls
            if (inferred === null) {
                inferred = t;
            }
            else if (inferred !== t) {
                // Mixed types: promote to TEXT (most flexible)
                inferred = "TEXT";
                break;
            }
        }
        // Default to TEXT if all values were null
        types.set(key, inferred ?? "TEXT");
    }
    return types;
}
function getExistingColumns(sql, table) {
    // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
    // Quote the table name to handle SQL reserved words (e.g. "group", "order")
    const pragmaQuery = `PRAGMA table_info("${table}")`;
    const strings = Object.assign([pragmaQuery], { raw: [pragmaQuery] });
    const rows = sql(strings);
    return rows.map((r) => ({ name: r.name, type: r.type }));
}
function createTable(sql, table, columns) {
    const colDefs = [...columns.entries()].map(([name, type]) => `"${name}" ${type}`).join(", ");
    const ddl = `CREATE TABLE IF NOT EXISTS "${table}" (${colDefs})`;
    const strings = Object.assign([ddl], { raw: [ddl] });
    sql(strings);
}
function addColumns(sql, table, newColumns) {
    for (const [name, type] of newColumns) {
        const ddl = `ALTER TABLE "${table}" ADD COLUMN "${name}" ${type}`;
        const strings = Object.assign([ddl], { raw: [ddl] });
        sql(strings);
    }
}
function batchInsert(sql, table, columns, data) {
    for (let offset = 0; offset < data.length; offset += INSERT_BATCH_SIZE) {
        const batch = data.slice(offset, offset + INSERT_BATCH_SIZE);
        const params = [];
        const valueTuples = [];
        for (const row of batch) {
            const placeholders = [];
            for (const col of columns) {
                const value = row[col];
                if (value === undefined || value === null) {
                    params.push(null);
                }
                else if (typeof value === "boolean") {
                    params.push(value ? 1 : 0);
                }
                else {
                    params.push(value);
                }
                placeholders.push("?");
            }
            valueTuples.push(`(${placeholders.join(", ")})`);
        }
        const colList = columns.map((c) => `"${c}"`).join(", ");
        const insertSql = `INSERT INTO "${table}" (${colList}) VALUES ${valueTuples.join(", ")}`;
        executeSql(sql, insertSql, params);
    }
}
// ---------------------------------------------------------------------------
// Tool entry
// ---------------------------------------------------------------------------
export const storeTools = [
    {
        name: "__store",
        description: "Store an array of flat objects into a SQLite table. Creates table if needed, evolves schema for new columns. Internal — only callable from V8 isolates.",
        hidden: true,
        schema: {
            table: z.string().describe("Target table name (alphanumeric + underscores, max 64 chars)"),
            data: z
                .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
                .describe("Array of flat objects to insert. Values must be scalars (string, number, boolean, null)."),
        },
        handler: async (input, ctx) => {
            const { table, data } = input;
            // 1. Validate table name
            const tableErr = validateTableName(table);
            if (tableErr)
                return tableErr;
            // 2. Validate data array
            const dataErr = validateData(data);
            if (dataErr)
                return dataErr;
            // 3. Validate columns and values
            const colErr = validateColumnsAndValues(data);
            if (colErr)
                return colErr;
            // 4. Infer column types
            const columnTypes = inferColumnTypes(data);
            const columns = [...columnTypes.keys()]; // alphabetically sorted
            try {
                // 5. Check if table exists and handle schema evolution
                const existing = getExistingColumns(ctx.sql, table);
                let created = false;
                let columnsAdded;
                if (existing.length === 0) {
                    // Table doesn't exist — create it
                    createTable(ctx.sql, table, columnTypes);
                    created = true;
                }
                else {
                    // Table exists — check for new columns
                    const existingNames = new Set(existing.map((c) => c.name));
                    const newColumns = new Map();
                    for (const [name, type] of columnTypes) {
                        if (!existingNames.has(name)) {
                            newColumns.set(name, type);
                        }
                    }
                    if (newColumns.size > 0) {
                        addColumns(ctx.sql, table, newColumns);
                        columnsAdded = [...newColumns.keys()];
                    }
                }
                // 6. Batch insert rows
                batchInsert(ctx.sql, table, columns, data);
                // 7. Return summary
                const result = {
                    table,
                    rows_inserted: data.length,
                    columns,
                };
                if (created)
                    result.created = true;
                if (columnsAdded && columnsAdded.length > 0)
                    result.columns_added = columnsAdded;
                return result;
            }
            catch (e) {
                const error = e instanceof Error ? e.message : String(e);
                return { error, error_code: "STORE_ERROR" };
            }
        },
    },
];
//# sourceMappingURL=store.js.map