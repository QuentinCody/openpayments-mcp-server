/**
 * API Proxy source — pure JS injected into V8 isolates.
 *
 * Provides:
 *   api.get(path, params)  — HTTP GET through server's fetch layer
 *   api.post(path, body, params) — HTTP POST
 *   api.query(dataAccessId, sql) — SQL query against staged data (alias for db.queryStaged)
 *   db.queryStaged(dataAccessId, sql) — SQL query against staged data (StorageContext design)
 *
 * API keys never enter the isolate — all HTTP goes through the host's apiFetch.
 *
 * Large responses (>30KB) are auto-staged into SQLite. When this happens,
 * the result has `__staged: true` with a `data_access_id` and `schema`.
 * Code can either return the staging metadata for the caller to use query_data,
 * or use api.query()/db.queryStaged() to query the data in-band with SQL.
 */
/**
 * Returns the JS source string to inject into V8 isolates.
 * Relies on `codemode` proxy being available (from evaluator prefix).
 */
export declare function buildApiProxySource(): string;
//# sourceMappingURL=api-proxy.d.ts.map