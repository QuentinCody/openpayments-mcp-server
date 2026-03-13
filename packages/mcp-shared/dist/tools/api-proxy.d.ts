/**
 * Hidden __api_proxy tool — routes V8 isolate api.get/api.post calls
 * through the server's HTTP fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It validates paths, delegates to the server's ApiFetchFn, and
 * auto-stages large responses via stageToDoAndRespond().
 */
import type { ToolEntry } from "../registry/types";
import type { ApiCatalog, ApiFetchFn } from "../codemode/catalog";
import type { ResolvedSpec } from "../codemode/openapi-resolver";
export interface ApiProxyToolOptions {
    apiFetch: ApiFetchFn;
    /** Optional legacy catalog metadata for drift hints */
    catalog?: ApiCatalog;
    /** Optional resolved OpenAPI metadata for drift hints */
    openApiSpec?: ResolvedSpec;
    /** DO namespace for auto-staging large responses */
    doNamespace?: unknown;
    /** Prefix for data access IDs (e.g., "gtex") */
    stagingPrefix?: string;
    /** Byte threshold for auto-staging (default 100KB) */
    stagingThreshold?: number;
}
/**
 * Create the hidden __api_proxy tool entry.
 */
export declare function createApiProxyTool(options: ApiProxyToolOptions): ToolEntry;
export interface QueryProxyToolOptions {
    /** DO namespace for querying staged data */
    doNamespace: unknown;
}
/**
 * Create the hidden __query_proxy tool entry.
 * Routes SQL queries from isolate api.query()/db.queryStaged() to the
 * Durable Object's /query endpoint via queryDataFromDo().
 */
export declare function createQueryProxyTool(options: QueryProxyToolOptions): ToolEntry;
//# sourceMappingURL=api-proxy.d.ts.map