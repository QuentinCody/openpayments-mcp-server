/**
 * Data Inserter — 2-phase insertion of entities into SQLite tables.
 *
 * Phase 1: Insert all entities depth-first (children before parents)
 *          so FK references are available when the parent is inserted.
 * Phase 2: Insert junction table records for many-to-many relationships.
 *
 * Design principle: NEVER silently lose data.
 *   - Insert failures are collected and reported in the result.
 *   - Fields that don't match any column are not dropped — the schema-builder
 *     should already have created columns for them (as _json or flattened).
 */
import type { DomainConfig, SqlExec, TableSchema } from "./types";
export interface InsertionResult {
    totalRows: number;
    errors: string[];
}
/**
 * Insert data into pre-created tables according to the given schemas.
 */
export declare function insertData(data: unknown, schemas: Record<string, TableSchema>, sql: SqlExec, config?: DomainConfig): InsertionResult;
//# sourceMappingURL=data-inserter.d.ts.map