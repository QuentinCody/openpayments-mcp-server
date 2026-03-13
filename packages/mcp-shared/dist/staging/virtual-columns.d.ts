/**
 * Virtual Columns Engine (Tier 1)
 *
 * For flat REST API arrays: store raw JSON in a single column and create
 * GENERATED ALWAYS AS (json_extract(...)) columns for direct SQL queries.
 *
 * This is simpler and faster than full normalization, and works well for
 * data that doesn't have nested entity relationships.
 *
 * The existing schema-inference.ts handles most Tier 1 logic already.
 * This module adds the generated-column variant as an alternative storage
 * mode that preserves the original JSON while still allowing SQL queries.
 */
import type { SqlExec } from "./types";
export interface VirtualColumnResult {
    tableName: string;
    rowCount: number;
    columnCount: number;
    errors: string[];
}
/**
 * Store an array of flat objects using raw JSON + generated columns.
 *
 * Each row stores the full JSON object in `_raw_json`, with generated columns
 * created for each top-level scalar field via json_extract().
 */
export declare function storeWithVirtualColumns(rows: unknown[], tableName: string, sql: SqlExec): VirtualColumnResult;
//# sourceMappingURL=virtual-columns.d.ts.map