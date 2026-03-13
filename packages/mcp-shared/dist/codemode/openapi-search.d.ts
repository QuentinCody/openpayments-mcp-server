/**
 * OpenAPI search — pure JS source injected into V8 isolates.
 *
 * Provides searchPaths(), listTags(), getOperation(), describeOperation()
 * functions that operate on a frozen `spec` object containing a resolved
 * OpenAPI spec (no $ref references).
 *
 * Analogous to catalog-search.ts but works with OpenAPI format instead of
 * the hand-written ApiCatalog format.
 */
/**
 * Returns the JS source string to inject into V8 isolates.
 * The resolved OpenAPI spec JSON is embedded as a frozen global `spec`.
 */
export declare function buildOpenApiSearchSource(specJson: string): string;
//# sourceMappingURL=openapi-search.d.ts.map