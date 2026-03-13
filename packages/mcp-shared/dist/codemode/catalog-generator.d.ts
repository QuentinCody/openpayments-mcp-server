/**
 * Catalog Generator — converts API specifications to ApiCatalog format.
 *
 * Supports four tiers of API documentation:
 *   Tier 1: OpenAPI 3.x (via ResolvedSpec from openapi-resolver.ts)
 *   Tier 2: Swagger 2.x (resolve first, then same as Tier 1)
 *   Tier 3: GraphQL introspection results
 *   Tier 4: Manual JSON/YAML definitions
 *
 * All tiers support an override system for enrichment.
 */
import type { ApiCatalog, ApiEndpoint, WorkflowRecipe } from "./catalog";
import type { ResolvedSpec } from "./openapi-resolver";
export interface CatalogDiagnostic {
    level: "info" | "warn" | "error";
    message: string;
    path?: string;
    method?: string;
}
export interface CatalogGeneratorResult {
    catalog: ApiCatalog;
    diagnostics: CatalogDiagnostic[];
}
/** Override for a single endpoint, keyed by "METHOD /path" */
export interface EndpointOverride extends Partial<Omit<ApiEndpoint, "method" | "path">> {
    /** Remove this endpoint from the catalog */
    exclude?: boolean;
}
export interface CatalogOverrides {
    /** Per-endpoint overrides, keyed by "METHOD /path" (e.g. "GET /studies/{nctId}") */
    endpoints?: Record<string, EndpointOverride>;
    /** Paths to exclude entirely */
    exclude?: string[];
    /** If set, only include these paths (allowlist) */
    include?: string[];
    /** Rename OpenAPI tags to categories */
    categoryMap?: Record<string, string>;
    /** Additional endpoints not in the source */
    additionalEndpoints?: ApiEndpoint[];
    /** Workflow recipes to add */
    workflows?: WorkflowRecipe[];
    /** Override catalog-level fields */
    catalog?: Partial<Pick<ApiCatalog, "name" | "baseUrl" | "version" | "auth" | "notes">>;
}
export type CategoryStrategy = "tag" | "path-prefix" | "operationId";
export interface OpenApiToCatalogOptions {
    name?: string;
    baseUrl?: string;
    auth?: string;
    notes?: string;
    categoryStrategy?: CategoryStrategy;
    includeExamples?: boolean;
    /** Include deprecated endpoints (marked with deprecated: true) */
    includeDeprecated?: boolean;
}
export interface GraphQlToCatalogOptions {
    name: string;
    baseUrl: string;
    auth?: string;
    notes?: string;
}
/**
 * Convert an OpenAPI/JSON-Schema object to a TypeScript-like shape string.
 * E.g. `{ id: string, items: Array<{ name: string, count: number }> }`
 */
export declare function schemaToResponseShape(schema: unknown, depth?: number): string;
/**
 * Convert a resolved (ref-free) OpenAPI spec to an ApiCatalog.
 * Swagger 2.x specs should be resolved via `resolveOpenApiSpec()` first,
 * which auto-converts them to OpenAPI 3.0 format.
 */
export declare function openApiToCatalog(spec: ResolvedSpec, options?: OpenApiToCatalogOptions): CatalogGeneratorResult;
/**
 * Convert a GraphQL introspection result to an ApiCatalog.
 * Each query becomes a virtual GET endpoint, each mutation a POST endpoint.
 * Arguments are mapped to queryParams for discoverability.
 */
export declare function graphQlToCatalog(introspection: unknown, options: GraphQlToCatalogOptions): CatalogGeneratorResult;
/**
 * Validate and normalize a manually-defined catalog from JSON/YAML.
 * Fills in defaults, normalizes types, and sets endpointCount.
 */
export declare function normalizeManualCatalog(raw: unknown): CatalogGeneratorResult;
/**
 * Apply overrides to a generated catalog. Works identically regardless of
 * which tier produced the catalog.
 */
export declare function applyOverrides(catalog: ApiCatalog, overrides: CatalogOverrides): CatalogGeneratorResult;
export type DetectedFormat = "openapi" | "graphql" | "manual";
/** Auto-detect the source format from a parsed object. */
export declare function detectFormat(source: unknown): DetectedFormat;
/**
 * Generate a TypeScript source file from an ApiCatalog.
 * Produces a complete .ts file with import and export.
 */
export declare function generateCatalogTypeScript(catalog: ApiCatalog, options: {
    exportName: string;
    sourceLabel?: string;
}): string;
//# sourceMappingURL=catalog-generator.d.ts.map