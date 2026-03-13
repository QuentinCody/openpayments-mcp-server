/**
 * Code Mode response helpers — shared across all MCP servers.
 *
 * Code Mode is a design pattern where LLMs write JavaScript code that calls MCP tools
 * as TypeScript APIs in a sandbox. Tools must return structured data in the
 * `structuredContent` field in addition to `content` (text).
 */
export interface CodeModeResponse<T = unknown> {
    [key: string]: unknown;
    /** Standard MCP text content for non-Code Mode clients */
    content: Array<{
        type: "text";
        text: string;
    }>;
    /** Structured content for Code Mode clients */
    structuredContent?: T;
    /** Error indicator */
    isError?: boolean;
}
export interface SuccessResponse<T = unknown> extends Record<string, unknown> {
    success: true;
    data: T;
    _meta?: {
        fetched_at?: string;
        data_access_id?: string;
        staged?: boolean;
        row_count?: number;
        [key: string]: unknown;
    };
}
export interface ErrorResponse extends Record<string, unknown> {
    success: false;
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
}
export type StructuredResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;
/**
 * Create a Code Mode compatible response with both text (for traditional MCP)
 * and structuredContent (for Code Mode).
 */
export declare function createCodeModeResponse<T>(data: T, options?: {
    textSummary?: string;
    meta?: Record<string, unknown>;
    maxPreviewChars?: number;
}): CodeModeResponse<SuccessResponse<T>>;
/**
 * Create a Code Mode compatible error response.
 */
export declare function createCodeModeError(code: string, message: string, details?: unknown): CodeModeResponse<ErrorResponse>;
/** Common error codes shared across servers */
export declare const ErrorCodes: {
    readonly INVALID_ARGUMENTS: "INVALID_ARGUMENTS";
    readonly MISSING_REQUIRED_PARAM: "MISSING_REQUIRED_PARAM";
    readonly API_ERROR: "API_ERROR";
    readonly API_TIMEOUT: "API_TIMEOUT";
    readonly API_RATE_LIMIT: "API_RATE_LIMIT";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly DATA_ACCESS_ERROR: "DATA_ACCESS_ERROR";
    readonly STAGING_ERROR: "STAGING_ERROR";
    readonly INVALID_SQL: "INVALID_SQL";
    readonly SQL_EXECUTION_ERROR: "SQL_EXECUTION_ERROR";
    readonly TIMEOUT: "TIMEOUT";
    readonly UNKNOWN_ERROR: "UNKNOWN_ERROR";
};
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
/**
 * Wrap an async tool function with Code Mode support and error handling.
 */
export declare function withCodeMode<TArgs, TResult>(fn: (args: TArgs, env?: unknown) => Promise<TResult>, options: {
    toolName: string;
    transformResult?: (result: TResult) => unknown;
    extractMeta?: (result: TResult) => Record<string, unknown>;
}): (args: TArgs, env?: unknown) => Promise<CodeModeResponse<StructuredResponse>>;
//# sourceMappingURL=response.d.ts.map