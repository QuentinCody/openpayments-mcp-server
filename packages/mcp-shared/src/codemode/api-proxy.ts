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

/** Wrap a staged response — THROW on payload access; a warning is not enough. */
function __wrapStaged(raw) {
  __stagedResults.push(raw);
  var msg = raw.message || "Response was auto-staged.";
  var hint = " THIS IS NOT AN EMPTY RESULT: the upstream returned data and it is in SQLite." +
    " Query it in-band with api.query('" + raw.data_access_id + "', 'SELECT * FROM <table> LIMIT 10')," +
    " or return this object and use the query_data tool with data_access_id='" + raw.data_access_id + "'," +
    " or re-request with a smaller page/limit param so the response never stages.";
  // These keys previously omitted "result"/"resultList" and merely console.warn'd,
  // returning undefined — so the idiomatic \`r.resultList?.result ?? []\` collapsed
  // to [] and the caller reported "no results" for a query whose upstream returned
  // plenty. Observed live 2026-07-15 against Europe PMC (58 hits read as 0) and
  // reproduced against deployed entrez 2026-07-16. A console.warn lands in isolate
  // logs the model never reads; only a throw is load-bearing.
  var TRAP_KEYS = ["results", "result", "resultList", "data", "entries", "items", "records", "rows", "hits", "nodes", "edges", "response", "collection", "content", "docs", "_embedded", "studies"];
  // T6.3 — a staged result is an object, NOT an array. Calling an array method
  // on it (e.g. openalexPapers.slice(...)) threw a cryptic "slice is not a
  // function". Return a thrower that explains the staged-data shape instead.
  var ARRAY_METHODS = ["slice","map","filter","forEach","reduce","reduceRight","find","findIndex","some","every","flatMap","flat","sort","reverse","concat","join","indexOf","lastIndexOf","includes","at","pop","push","shift","unshift","splice","fill","keys","values","entries"];
  return new Proxy(raw, {
    get: function(target, prop) {
      if (typeof prop === "string" && !(prop in target)) {
        if (TRAP_KEYS.indexOf(prop) !== -1) {
          throw new Error("This response was AUTO-STAGED (" + (raw.total_rows != null ? raw.total_rows + " rows" : "large payload") + ") — '" + prop + "' does not exist on the staging envelope. Reading it yields undefined, which silently reads as 'no results'." + hint + " Envelope keys: __staged, data_access_id, total_rows, columns, schema, tables_created, message.");
        }
        if (ARRAY_METHODS.indexOf(prop) !== -1) {
          return function() {
            throw new Error("This is a STAGED result OBJECT, not an array — '." + prop + "()' is not available. The rows live in SQLite, not on this object." + hint);
          };
        }
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
  // Surface truncated/total_matching so isolate code can tell whether it saw
  // the full result set or only the first page (max 1000 rows per query).
  var out = { results: result.rows || [], row_count: result.row_count || 0 };
  if (result.truncated !== undefined) out.truncated = result.truncated;
  if (result.total_matching !== undefined) out.total_matching = result.total_matching;
  return out;
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
   * Fetch EVERY page of a paged endpoint and return the combined records.
   * Prevents silent under-counting (fetching only page 1 of N).
   *   const all = await api.getAll("/search", { db: "nuccore", term: "..." },
   *     { strategy: "offset", offsetParam: "retstart", limitParam: "retmax", pageSize: 500 });
   *   // all = { items, count, pages, total_available, completeness }
   * opts: strategy ("offset"|"page"|"cursor"), pageSize, offsetParam, limitParam,
   *   pageParam, pageSizeParam, cursorParam, nextField, itemsField, max, maxPages.
   * Check result.completeness.complete — if false, result.completeness.truncation
   * explains what was cut off and how to get the rest. Large sets auto-stage.
   */
  getAll: async function(path, params, opts) {
    var result = await codemode.__paginate_proxy({
      path: path,
      params: params || {},
      opts: opts || {},
    });
    if (result && result.__api_error) {
      var err = new Error("API error " + result.status + ": " + (result.message || "Unknown error"));
      err.status = result.status;
      err.data = result.data;
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

/** Guiding stub (T4.3): this is a REST server — gql.query doesn't exist here. */
var gql = {
  query: function() {
    throw new Error("gql.query is not available on this REST server — use api.get(path, params) or api.post(path, body, params). Call searchSpec(query) / listCategories() to discover endpoints first.");
  },
};
// --- End API proxy helpers ---
`;
}

/**
 * REST-capability override — injected into a GraphQL isolate (AFTER
 * {@link buildGraphqlProxySource}) when a server wires a SECOND, REST upstream
 * via `restApiFetch` (a hybrid GraphQL+REST Code Mode server). It REASSIGNS the
 * GraphQL proxy's throwing `api.get`/`api.post` stubs to real implementations
 * routed through the host `__api_proxy`, reusing the already-defined
 * `__wrapStaged` for auto-staged responses.
 *
 * It declares NO `var` — `api`, `db`, `gql`, and `__wrapStaged` already exist
 * from buildGraphqlProxySource, so redeclaring them in the same module scope is
 * a parse error. That is precisely why this is a slim mutating override and not
 * a second {@link buildApiProxySource} concatenation.
 */
export function buildRestApiOverrideSource(): string {
	return `
// --- REST capability (injected: second upstream via restApiFetch) ---
function __unwrapApiResult(result) {
  if (result && result.__api_error) {
    var errorMessage = result.message || "Unknown error";
    if (result.drift_hint && result.drift_hint.message) errorMessage += " " + result.drift_hint.message;
    var err = new Error("API error " + result.status + ": " + errorMessage);
    err.status = result.status; err.data = result.data; err.driftHint = result.drift_hint;
    throw err;
  }
  if (result && result.__staged) return __wrapStaged(result);
  return result;
}
api.get = async function(path, params) {
  return __unwrapApiResult(await codemode.__api_proxy({ method: "GET", path: path, params: params || {} }));
};
api.post = async function(path, body, params) {
  return __unwrapApiResult(await codemode.__api_proxy({ method: "POST", path: path, params: params || {}, body: body }));
};
// --- End REST capability ---
`;
}
