/**
 * OpenAPI spec resolver — resolves $ref references and converts Swagger 2.0
 * to OpenAPI 3.0 format.
 *
 * Used to produce a self-contained, reference-free JSON spec that can be
 * injected into V8 isolates for Code Mode search tools.
 */
import type { ApiCatalog } from "./catalog";
export interface ResolveOptions {
    /** Remove x-* extension fields from the output */
    stripExtensions?: boolean;
    /** Remove example/examples fields from the output */
    stripExamples?: boolean;
}
export interface ResolvedSpec {
    openapi: string;
    info: {
        title: string;
        version: string;
        [k: string]: unknown;
    };
    servers?: Array<{
        url: string;
        [k: string]: unknown;
    }>;
    paths: Record<string, Record<string, unknown>>;
}
/**
 * Resolve an OpenAPI/Swagger spec by inlining all $ref references.
 *
 * Supports:
 * - OpenAPI 3.0.x specs with $ref in parameters, schemas, responses
 * - Swagger 2.0 specs (auto-converted to OpenAPI 3.0 format)
 * - Nested and chained $ref resolution
 * - Circular reference detection
 * - Optional stripping of x-* extensions and examples
 *
 * @throws Error if a $ref cannot be resolved
 */
export declare function resolveOpenApiSpec(raw: unknown, options?: ResolveOptions): ResolvedSpec;
/**
 * Merge legacy catalog endpoints into a resolved OpenAPI spec.
 *
 * This preserves partial published specs while retaining server-specific
 * endpoints and curated descriptions that only exist in catalog.ts.
 */
export declare function mergeCatalogIntoResolvedSpec(spec: ResolvedSpec, catalog: ApiCatalog): ResolvedSpec;
//# sourceMappingURL=openapi-resolver.d.ts.map