/**
 * Direct SQL query tool for V8 isolates.
 *
 * Provides a fast read-only SQL path (`__query`, `__query_batch`) that
 * bypasses full tool dispatch overhead. Hidden from MCP clients —
 * only callable from coordination scripts via the codemode proxy.
 *
 * Security layers:
 *   1. Read-only enforcement (SELECT/WITH only, no write keywords, no semicolons)
 *   2. Table deny list (system tables, sensitive tables)
 *   3. Sensitive column redaction
 *   4. Row count and result size limits
 */
import type { ToolEntry } from "../registry/types";
/**
 * Tables that should never be accessible via direct query.
 * Extend this set for tables containing secrets or PII.
 */
export declare const DENIED_TABLES: Set<string>;
/**
 * Column names whose values are replaced with "[REDACTED]" in results.
 * Applied globally across all tables (SQLite JOINs return flat column names).
 */
export declare const REDACTED_COLUMNS: Set<string>;
/**
 * Strip all SQL comments (single-line `--` and block comments).
 * Applied before keyword checks to prevent bypass via comment injection.
 */
export declare function stripComments(sql: string): string;
/**
 * Strict read-only validation for direct queries.
 * More restrictive than `isReadOnly()` in sql-helpers — blocks PRAGMA and EXPLAIN,
 * enforces SELECT/WITH prefix, and scans for all write keywords.
 */
export declare function isStrictReadOnly(sql: string): {
    valid: boolean;
    error?: string;
};
/**
 * Extract all table names referenced in a SQL query.
 * Matches tables after FROM and JOIN keywords — since every table reference
 * in a SELECT (including subqueries, CTEs, EXISTS) must use FROM or JOIN,
 * this catches all cases.
 *
 * Handles schema-qualified names (e.g. main.sqlite_master, main."sqlite_master")
 * by extracting both the schema and table portions. This prevents bypass of the
 * deny list via schema qualification.
 */
export declare function extractTableNames(sql: string): Set<string>;
/**
 * Validate that all referenced tables are allowed.
 */
export declare function validateTableAccess(tables: Set<string>, deniedTables?: Set<string>): {
    valid: boolean;
    error?: string;
};
/**
 * Replace sensitive column values with "[REDACTED]".
 */
export declare function redactRow(row: Record<string, unknown>, redactedColumns?: Set<string>): Record<string, unknown>;
/**
 * Append a LIMIT clause if the query doesn't already have one.
 * Uses MAX_ROWS + 1 so we can detect truncation.
 *
 * Operates on comment-stripped SQL to prevent bypass via trailing comments
 * (which would swallow the appended clause). Also detects parameterized
 * limits (`LIMIT ?`) to avoid appending a conflicting second LIMIT.
 */
export declare function ensureLimit(sql: string, maxRows?: number): string;
export declare const directQueryTools: ToolEntry[];
//# sourceMappingURL=direct-query.d.ts.map