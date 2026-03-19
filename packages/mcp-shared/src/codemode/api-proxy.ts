/**
 * API Proxy source — pure JS injected into V8 isolates.
 *
 * Provides:
 *   api.get(path, params)  — HTTP GET through server's fetch layer
 *   api.post(path, body, params) — HTTP POST
 *   api.query(dataAccessId, sql) — SQL query against staged data (alias for db.queryStaged)
 *   db.queryStaged(dataAccessId, sql) — SQL query against staged data
 *   db.stage(data, tableName?) — stage arbitrary data into SQLite, returns { data_access_id, ... }
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
export function buildApiProxySource(): string {
	return `
// --- API proxy helpers (injected) ---
// __stagedResults is declared in the evaluate() scope (module prefix) so it's
// accessible both inside this IIFE and in the module suffix return statement.

/** Wrap a staged response — warn on data array access instead of throwing. */
function __wrapStaged(raw) {
  __stagedResults.push(raw);
  var msg = raw.message || "Response was auto-staged.";
  var hint = " Return this object and use the query_data tool with data_access_id=\\"" +
    raw.data_access_id + "\\" to query it with SQL.";
  var TRAP_KEYS = ["results", "data", "entries", "items", "records", "rows", "hits", "nodes", "edges"];
  return new Proxy(raw, {
    get: function(target, prop) {
      if (typeof prop === "string" && TRAP_KEYS.indexOf(prop) !== -1 && !(prop in target)) {
        console.warn("[staging] Accessed \\\"" + prop + "\\\" on staged response — this array was replaced by SQLite tables. " + hint);
        return undefined;
      }
      return target[prop];
    }
  });
}

/**
 * Stage arbitrary data into SQLite. Returns staging metadata with data_access_id.
 * @param data - Array of objects or single object to stage
 * @param tableNameOrOptions - String table name (legacy) or options object with schema hints
 */
async function __stageData(data, tableNameOrOptions) {
  if (data === undefined || data === null) throw new Error("db.stage() requires data (array or object)");
  var tableName;
  var schemaHints;
  if (typeof tableNameOrOptions === "string") {
    tableName = tableNameOrOptions;
  } else if (tableNameOrOptions && typeof tableNameOrOptions === "object") {
    tableName = tableNameOrOptions.tableName;
    schemaHints = tableNameOrOptions.schema || undefined;
  }
  var result = await codemode.__stage_proxy({
    data: data,
    table_name: tableName || undefined,
    schema_hints: schemaHints || undefined,
  });
  if (result && result.__stage_error) {
    throw new Error("Staging failed: " + (result.message || "Unknown error"));
  }
  return result;
}

/** Query staged data via SQL. Shared implementation for api.query and db.queryStaged. */
async function __queryStaged(dataAccessId, sql) {
  if (!dataAccessId) throw new Error("dataAccessId is required");
  if (!sql) throw new Error("sql is required");
  var result = await codemode.__query_proxy({
    data_access_id: dataAccessId,
    sql: sql,
  });
  if (result && result.__query_error) {
    throw new Error("Query failed: " + (result.message || "Unknown error"));
  }
  return { results: result.rows || [], row_count: result.row_count || 0 };
}

var api = {
  /**
   * GET request. Path params are interpolated: api.get("/lookup/id/{id}", { id: "ENSG..." })
   * becomes GET /lookup/id/ENSG...
   * Extra params become query string parameters.
   *
   * If the response is large (>30KB), it is auto-staged into SQLite.
   * In that case the return value has __staged=true, data_access_id, and schema.
   * Use api.query(result.data_access_id, sql) to query it in-band,
   * or return the staging info for the caller to use query_data.
   */
  get: async function(path, params) {
    var result = await codemode.__api_proxy({
      method: "GET",
      path: path,
      params: params || {},
    });
    if (result && result.__api_error) {
      var errorMessage = result.message || "Unknown error";
      if (result.drift_hint && result.drift_hint.message) {
        errorMessage += " " + result.drift_hint.message;
      }
      var err = new Error("API error " + result.status + ": " + errorMessage);
      err.status = result.status;
      err.data = result.data;
      err.driftHint = result.drift_hint;
      throw err;
    }
    if (result && result.__staged) {
      return __wrapStaged(result);
    }
    return result;
  },

  /**
   * POST request with JSON body.
   * Same staging behavior as api.get() for large responses.
   */
  post: async function(path, body, params) {
    var result = await codemode.__api_proxy({
      method: "POST",
      path: path,
      params: params || {},
      body: body,
    });
    if (result && result.__api_error) {
      var errorMessage = result.message || "Unknown error";
      if (result.drift_hint && result.drift_hint.message) {
        errorMessage += " " + result.drift_hint.message;
      }
      var err = new Error("API error " + result.status + ": " + errorMessage);
      err.status = result.status;
      err.data = result.data;
      err.driftHint = result.drift_hint;
      throw err;
    }
    if (result && result.__staged) {
      return __wrapStaged(result);
    }
    return result;
  },

  /**
   * Query staged data with SQL. Use after api.get/api.post returns __staged=true.
   *   const result = await api.get(path, params);
   *   if (result.__staged) {
   *     const rows = await api.query(result.data_access_id, "SELECT * FROM " + result.tables_created[0] + " LIMIT 10");
   *     return rows.results;
   *   }
   * Returns { results: [...], row_count: N }.
   * Only SELECT queries are allowed. Max 1000 rows.
   */
  query: function(dataAccessId, sql) {
    return __queryStaged(dataAccessId, sql);
  },
};

/** StorageContext — database-first API for working with staged data (ADR-004). */
var db = {
  /**
   * Query staged data with SQL. Alias for api.query().
   *   if (result.__staged) {
   *     const grouped = await db.queryStaged(result.data_access_id,
   *       "SELECT category, COUNT(*) as n FROM " + result.tables_created[0] + " GROUP BY category"
   *     );
   *     return grouped.results;
   *   }
   * Returns { results: [...], row_count: N }.
   */
  queryStaged: function(dataAccessId, sql) {
    return __queryStaged(dataAccessId, sql);
  },

  /**
   * Stage arbitrary data into SQLite. Use this to persist computed/filtered
   * results so they can be queried with SQL without re-entering the context window.
   *
   * Simple usage (table name only):
   *   const staged = await db.stage(filtered.results, 'high_confidence');
   *
   * With schema hints (control column types, indexes, etc.):
   *   const staged = await db.stage(myData, {
   *     tableName: 'gene_scores',
   *     schema: {
   *       columnTypes: { score: 'REAL', chromosome: 'TEXT' },
   *       indexes: ['gene_symbol', 'score'],
   *       compositeIndexes: [['gene_symbol', 'chromosome']],
   *       exclude: ['internal_id'],
   *       skipChildTables: ['raw_annotations'],
   *     }
   *   });
   *
   * Schema hint options:
   *   - columnTypes: { colName: 'TEXT'|'INTEGER'|'REAL'|'JSON' } — override inferred types
   *   - indexes: ['col1', 'col2'] — add single-column indexes
   *   - compositeIndexes: [['col1', 'col2']] — add multi-column indexes
   *   - exclude: ['col'] — exclude columns from the table
   *   - skipChildTables: ['col'] — keep array-of-objects columns as JSON instead of child tables
   *   - maxRecursionDepth: 1 — limit child table nesting depth (default 2)
   *
   * @param data - Array of objects or single object to stage
   * @param tableNameOrOptions - String table name, or { tableName?, schema? } options
   * @returns { data_access_id, tables_created, total_rows, schema }
   */
  stage: function(data, tableNameOrOptions) {
    return __stageData(data, tableNameOrOptions);
  },
};
// --- End API proxy helpers ---
`;
}
