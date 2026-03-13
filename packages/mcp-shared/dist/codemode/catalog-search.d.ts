/**
 * Catalog search — pure JS source injected into V8 isolates.
 *
 * Provides searchSpec(), listCategories(), getEndpoint(), describeEndpoint()
 * functions that operate on the frozen SPEC object inside the isolate.
 */
/**
 * Returns the JS source string to inject into V8 isolates.
 * The catalog JSON is embedded as a frozen global `SPEC`.
 */
export declare function buildCatalogSearchSource(catalogJson: string): string;
//# sourceMappingURL=catalog-search.d.ts.map