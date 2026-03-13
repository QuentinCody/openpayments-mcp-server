/**
 * Stub generator — auto-generates code examples and quick references from
 * API catalog endpoints and OpenAPI operations.
 *
 * These stubs are surfaced in _search results and _execute tool descriptions
 * so the LLM can write more accurate api.get()/api.post() calls.
 */
import type { ApiCatalog, ApiEndpoint } from "./catalog";
interface OpenApiParameter {
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
    schema?: {
        type?: string;
        default?: unknown;
        example?: unknown;
        enum?: unknown[];
    };
    type?: string;
    example?: unknown;
}
interface OpenApiOperation {
    path: string;
    method: string;
    summary?: string;
    description?: string;
    operationId?: string;
    tags?: string[];
    parameters?: OpenApiParameter[];
    requestBody?: {
        description?: string;
        required?: boolean;
        content?: Record<string, {
            schema?: {
                type?: string;
                properties?: Record<string, unknown>;
            };
        }>;
    };
}
/**
 * Generate a code example for an ApiEndpoint.
 * Returns the manual `ep.example` if set, otherwise auto-generates from params.
 */
export declare function generateEndpointStub(ep: ApiEndpoint): string;
/**
 * Generate a code example from an OpenAPI operation.
 */
export declare function generateOperationStub(op: OpenApiOperation): string;
/**
 * Generate a compact one-line-per-endpoint quick reference for the tool description.
 * Prioritizes non-deprecated, non-coveredByTool endpoints.
 */
export declare function generateQuickReference(options: {
    catalog?: ApiCatalog;
    openApiSpec?: {
        paths: Record<string, Record<string, unknown>>;
    };
    max?: number;
    prefix?: string;
}): string;
/**
 * Generate TypeScript type hint comments for injection into V8 isolate preambles.
 *
 * These hints help the LLM understand parameter types, required vs optional,
 * enum values, and response shapes without needing to call _search first.
 *
 * Includes a note about staging for large responses.
 */
export declare function generateTypeHints(options: {
    catalog?: ApiCatalog;
    openApiSpec?: {
        paths: Record<string, Record<string, unknown>>;
    };
    max?: number;
}): string;
export {};
//# sourceMappingURL=stub-generator.d.ts.map