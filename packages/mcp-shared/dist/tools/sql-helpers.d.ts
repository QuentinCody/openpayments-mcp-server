import type { SqlTaggedTemplate } from "../registry/types";
export declare function isReadOnly(query: string): boolean;
export declare function isBlocked(query: string): boolean;
/**
 * Execute a SQL query with optional parameters using the tagged template literal.
 * Builds a proper tagged template call to ensure parameterized execution.
 */
export declare function executeSql<T = Record<string, string | number | boolean | null>>(sql: SqlTaggedTemplate, query: string, params?: (string | number | boolean | null)[]): T[];
//# sourceMappingURL=sql-helpers.d.ts.map