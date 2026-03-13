/**
 * REST HTTP fetch utility with retry, timeout, and query string construction.
 */
export interface RestFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | object;
    timeout?: number;
    retries?: number;
    retryOn?: number[];
    userAgent?: string;
}
/**
 * Build a query string from a params object. Handles arrays, undefined values.
 */
export declare function buildQueryString(params: Record<string, unknown>): string;
/**
 * Fetch a REST API with retries, timeout, and query string construction.
 */
export declare function restFetch(baseUrl: string, path: string, params?: Record<string, unknown>, opts?: RestFetchOptions): Promise<Response>;
//# sourceMappingURL=rest-fetch.d.ts.map