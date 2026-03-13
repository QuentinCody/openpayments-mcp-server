/**
 * Code Mode response helpers — shared across all MCP servers.
 *
 * Code Mode is a design pattern where LLMs write JavaScript code that calls MCP tools
 * as TypeScript APIs in a sandbox. Tools must return structured data in the
 * `structuredContent` field in addition to `content` (text).
 */
/**
 * Create a Code Mode compatible response with both text (for traditional MCP)
 * and structuredContent (for Code Mode).
 */
export function createCodeModeResponse(data, options = {}) {
    const { textSummary, meta, maxPreviewChars = 10000 } = options;
    const structured = {
        success: true,
        data,
        ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    };
    let text;
    if (textSummary) {
        text = textSummary;
    }
    else {
        const jsonStr = JSON.stringify(structured, null, 2);
        if (jsonStr.length <= maxPreviewChars) {
            text = jsonStr;
        }
        else {
            text = `${jsonStr.slice(0, maxPreviewChars)}\n... [truncated for display]`;
        }
    }
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
}
/**
 * Create a Code Mode compatible error response.
 */
export function createCodeModeError(code, message, details) {
    const structured = {
        success: false,
        error: {
            code,
            message,
            ...(details !== undefined ? { details } : {}),
        },
    };
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        structuredContent: structured,
        isError: true,
    };
}
/** Common error codes shared across servers */
export const ErrorCodes = {
    INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
    MISSING_REQUIRED_PARAM: "MISSING_REQUIRED_PARAM",
    API_ERROR: "API_ERROR",
    API_TIMEOUT: "API_TIMEOUT",
    API_RATE_LIMIT: "API_RATE_LIMIT",
    NOT_FOUND: "NOT_FOUND",
    DATA_ACCESS_ERROR: "DATA_ACCESS_ERROR",
    STAGING_ERROR: "STAGING_ERROR",
    INVALID_SQL: "INVALID_SQL",
    SQL_EXECUTION_ERROR: "SQL_EXECUTION_ERROR",
    TIMEOUT: "TIMEOUT",
    UNKNOWN_ERROR: "UNKNOWN_ERROR",
};
/**
 * Wrap an async tool function with Code Mode support and error handling.
 */
export function withCodeMode(fn, options) {
    return async (args, env) => {
        try {
            const result = await fn(args, env);
            const transformed = options.transformResult
                ? options.transformResult(result)
                : result;
            const meta = options.extractMeta
                ? options.extractMeta(result)
                : undefined;
            return createCodeModeResponse(transformed, { meta });
        }
        catch (error) {
            let code = ErrorCodes.UNKNOWN_ERROR;
            let message = String(error);
            if (error instanceof Error) {
                message = error.message;
                if (message.includes("Invalid arguments") || message.includes("validation")) {
                    code = ErrorCodes.INVALID_ARGUMENTS;
                }
                else if (message.includes("required")) {
                    code = ErrorCodes.MISSING_REQUIRED_PARAM;
                }
                else if (message.includes("not found") || message.includes("Not Found")) {
                    code = ErrorCodes.NOT_FOUND;
                }
                else if (message.includes("timeout") || message.includes("timed out")) {
                    code = ErrorCodes.TIMEOUT;
                }
                else if (message.includes("rate limit") || message.includes("429")) {
                    code = ErrorCodes.API_RATE_LIMIT;
                }
                else if (message.includes("HTTP")) {
                    code = ErrorCodes.API_ERROR;
                }
                else if (message.includes("SQL") || message.includes("query")) {
                    code = ErrorCodes.SQL_EXECUTION_ERROR;
                }
            }
            return createCodeModeError(code, `${options.toolName} failed: ${message}`);
        }
    };
}
//# sourceMappingURL=response.js.map