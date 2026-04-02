/**
 * GraphQL proxy source — pure JS injected into V8 isolates.
 *
 * Provides:
 *   gql.query(queryString, variables?) — execute GraphQL queries through server's fetch layer
 *   api.query(dataAccessId, sql)       — SQL query against staged data
 *   db.queryStaged(dataAccessId, sql)  — alias for api.query
 *   db.stage(data, tableName?)         — stage arbitrary data into SQLite
 *
 * API keys never enter the isolate — all HTTP goes through the host's gqlFetch.
 *
 * Large responses (>30KB) are auto-staged into SQLite. When this happens,
 * the result has `__staged: true` with a `data_access_id` and `schema`.
 */

/**
 * Returns the JS source string to inject into V8 isolates.
 * Relies on `codemode` proxy being available (from evaluator prefix).
 */
export function buildGraphqlProxySource(): string {
	return `
// --- GraphQL proxy helpers (injected) ---
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
        console.warn("[staging] Accessed \\"" + prop + "\\" on staged response — this array was replaced by SQLite tables. " + hint);
        return undefined;
      }
      return target[prop];
    }
  });
}

/**
 * Stage arbitrary data into SQLite. Returns staging metadata with data_access_id.
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

/** Query staged data via SQL. */
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

var gql = {
  /**
   * Execute a GraphQL query. Variables are optional.
   *   const result = await gql.query('{ gene(entrezSymbol: "EGFR") { id name } }');
   *   // result.gene.id, result.gene.name — data is at the top level
   *
   * Returns the GraphQL data object directly (unwrapped from the data envelope).
   * If the response is large (>30KB), it is auto-staged into SQLite.
   * In that case the return value has __staged=true and data_access_id.
   *
   * If the API returned partial errors alongside data, they are available
   * on result.__errors (array). Errors WITHOUT any data throw an exception.
   */
  query: async function(query, variables) {
    var result = await codemode.__graphql_proxy({
      query: query,
      variables: variables || undefined,
    });
    if (result && result.__gql_error) {
      var err = new Error("GraphQL error: " + result.message);
      err.errors = result.errors;
      throw err;
    }
    if (result && result.__staged) {
      return __wrapStaged(result);
    }
    return result;
  },
};

var api = {
  /**
   * Query staged data with SQL. Use after gql.query returns __staged=true.
   */
  query: function(dataAccessId, sql) {
    return __queryStaged(dataAccessId, sql);
  },
};

/** StorageContext — database-first API for working with staged data. */
var db = {
  /**
   * Query staged data with SQL.
   */
  queryStaged: function(dataAccessId, sql) {
    return __queryStaged(dataAccessId, sql);
  },

  /**
   * Stage arbitrary data into SQLite. Returns { data_access_id, tables_created, total_rows }.
   */
  stage: function(data, tableNameOrOptions) {
    return __stageData(data, tableNameOrOptions);
  },
};
// --- End GraphQL proxy helpers ---
`;
}
