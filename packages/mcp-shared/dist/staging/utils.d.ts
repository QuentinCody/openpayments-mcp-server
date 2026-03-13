/**
 * Staging utilities — decision logic, DO interaction, data access ID generation.
 */
import type { SchemaHints } from "./schema-inference";
import { type StagingMetadata } from "./staging-metadata";
/** Decide whether a response should be staged based on byte size. */
export declare function shouldStage(responseBytes: number, threshold?: number): boolean;
/** Generate a unique data access ID. */
export declare function generateDataAccessId(prefix: string): string;
interface DurableObjectStub {
    fetch(req: Request): Promise<Response>;
}
interface DurableObjectNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): DurableObjectStub;
}
export interface StagingProvenance {
    toolName?: string;
    serverName?: string;
    args?: Record<string, unknown>;
    apiUrl?: string;
}
export interface StageResult {
    dataAccessId: string;
    schema: unknown;
    tablesCreated: string[] | undefined;
    totalRows: number | undefined;
    inputRows: number | undefined;
    stagingWarnings: Record<string, unknown> | undefined;
    /** Universal staging metadata — include as `_staging` in structuredContent */
    _staging: StagingMetadata;
}
/**
 * Stage data to a Durable Object and return a structuredContent response
 * with the data_access_id for subsequent SQL queries.
 *
 * @param toolPrefix - Tool name prefix for query_data/get_schema tool names (e.g. "ctgov", "faers").
 *   If not provided, falls back to `prefix` (the data access ID prefix).
 * @param sessionId - MCP transport session ID. When provided, registers the staged dataset
 *   in a session-scoped registry so get_schema can list available datasets after context compaction.
 */
export declare function stageToDoAndRespond(data: unknown, doNamespace: DurableObjectNamespace, prefix: string, _schemaHints?: SchemaHints, provenance?: StagingProvenance, toolPrefix?: string, sessionId?: string): Promise<StageResult>;
/**
 * Query staged data from a Durable Object with SQL safety checks.
 */
export declare function queryDataFromDo(doNamespace: DurableObjectNamespace, dataAccessId: string, sql: string, limit?: number): Promise<{
    rows: unknown[];
    row_count: number;
    sql: string;
    data_access_id: string;
    executed_at: string;
}>;
/**
 * Get schema metadata from a Durable Object.
 */
export declare function getSchemaFromDo(doNamespace: DurableObjectNamespace, dataAccessId: string): Promise<{
    data_access_id: string;
    schema: object;
    retrieved_at: string;
}>;
/**
 * Standard query_data tool handler. Use in registerTool callback.
 */
export declare function createQueryDataHandler(doBindingName: string, toolPrefix: string): (args: Record<string, unknown>, env: Record<string, unknown>) => Promise<import("..").CodeModeResponse<import("..").ErrorResponse> | import("..").CodeModeResponse<import("..").SuccessResponse<{
    rows: unknown[];
    row_count: number;
    sql: string;
    data_access_id: string;
    executed_at: string;
}>>>;
/**
 * Standard get_schema tool handler. Use in registerTool callback.
 *
 * When `data_access_id` is provided, returns the schema for that specific dataset.
 * When omitted, uses the MCP session to list all staged datasets available in this session.
 */
export declare function createGetSchemaHandler(doBindingName: string, toolPrefix: string): (args: Record<string, unknown>, env: Record<string, unknown>, sessionId?: string) => Promise<import("..").CodeModeResponse<import("..").ErrorResponse> | import("..").CodeModeResponse<import("..").SuccessResponse<{
    data_access_id: string;
    schema: object;
    retrieved_at: string;
}>> | import("..").CodeModeResponse<import("..").SuccessResponse<{
    staged_datasets: never[];
    message: string;
}>> | import("..").CodeModeResponse<import("..").SuccessResponse<{
    staged_datasets: {
        data_access_id: string;
        tool_name: string | null;
        tables: string[];
        total_rows: number | null;
        query_tool: string;
        schema_tool: string;
        created_at: string;
    }[];
    hint: string;
}>>>;
export {};
//# sourceMappingURL=utils.d.ts.map