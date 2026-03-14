/**
 * Universal Schema Inference Engine — JSON → SQLite converter for REST API responses.
 *
 * Deterministic: same input always produces same schema.
 *
 * Improvements over v1:
 *   1. Large strings (>4KB) → TEXT (not JSON)
 *   2. Arrays of scalars → pipe-delimited TEXT columns
 *   3. Arrays of objects → child tables with parent_id FK
 *   4. Remaining JSON columns carry jsonShape metadata
 *
 * v3 improvements:
 *   5. Transaction boundaries for INSERT batches (10-50x perf gain)
 *   6. Two-pass column discovery — scans beyond sample for sparse columns
 *   7. Biological identifier auto-indexing (gene_symbol, rsid, etc.)
 *   8. Composite index support via SchemaHints
 *   9. Cached column classification (avoids redundant scans)
 *  10. Deduplicated table creation logic
 */
export interface SchemaHints {
    tableName?: string;
    columnTypes?: Record<string, string>;
    indexes?: string[];
    flatten?: Record<string, number>;
    exclude?: string[];
    /** Columns to NOT extract as child tables — keep as JSON blobs */
    skipChildTables?: string[];
    /** Max depth for recursive child table extraction (default 2: parent → child → grandchild) */
    maxRecursionDepth?: number;
    /** Multi-column indexes, e.g. [["gene_symbol", "clinical_significance"]] */
    compositeIndexes?: string[][];
}
export interface InferredColumn {
    name: string;
    type: "TEXT" | "INTEGER" | "REAL" | "JSON";
    /** Shape description for JSON columns (e.g., "{version: number, flags: object}") */
    jsonShape?: string;
    /** True for TEXT columns that contain pipe-delimited scalar arrays (searchable with LIKE) */
    pipeDelimited?: boolean;
}
/** Reference from a child table back to its parent */
export interface ChildTableRef {
    parentTable: string;
    fkColumn: string;
    sourceColumn: string;
}
export interface InferredTable {
    name: string;
    columns: InferredColumn[];
    indexes: string[];
    /** Multi-column indexes */
    compositeIndexes?: string[][];
    /** Set on child tables extracted from arrays of objects */
    childOf?: ChildTableRef;
}
export interface InferredSchema {
    tables: InferredTable[];
}
/**
 * Find the array(s) in a JSON response that should become tables.
 */
export declare function detectArrays(data: unknown): Array<{
    key: string;
    rows: unknown[];
}>;
/**
 * Flatten an object's keys with `_` separator up to a given depth.
 */
export declare function flattenObject(obj: Record<string, unknown>, maxDepth: number, depthOverrides?: Record<string, number>, prefix?: string, currentDepth?: number): Record<string, unknown>;
/**
 * Infer a complete schema from detected arrays.
 *
 * Two-pass column discovery:
 *   Pass 1: Flatten up to MAX_SCAN_ROWS for type inference.
 *   Pass 2: Scan up to MAX_DISCOVERY_ROWS beyond the sample to find
 *           sparse columns that only appear in later rows.
 *
 * Column classification is cached from the first pass to avoid redundant scans.
 */
export declare function inferSchema(arrays: Array<{
    key: string;
    rows: unknown[];
}>, hints?: SchemaHints): InferredSchema;
export interface MaterializationWarning {
    rowIndex: number;
    table: string;
    error: string;
}
export interface MaterializationResult {
    tablesCreated: string[];
    totalRows: number;
    inputRows: number;
    failedRows: number;
    warnings: MaterializationWarning[];
    /** Row count per table — useful for reporting per-table breakdowns */
    tableRowCounts: Record<string, number>;
}
/**
 * Generate CREATE TABLE + INSERT statements and execute them.
 *
 * Handles parent/child/grandchild table relationships:
 * - Tables are processed in topological order (parent before child before grandchild)
 * - Each level tracks row IDs for FK resolution at the next level
 *
 * Callers should wrap this in a transaction for performance
 * (10-50x faster than implicit per-statement autocommit).
 * In Cloudflare Durable Objects, use ctx.storage.transactionSync().
 */
export declare function materializeSchema(schema: InferredSchema, rows: Map<string, unknown[]>, sql: {
    exec: (query: string, ...bindings: unknown[]) => unknown;
}, hints?: SchemaHints): MaterializationResult;
//# sourceMappingURL=schema-inference.d.ts.map