/**
 * SPARQL proxy source — pure JS injected into V8 isolates.
 *
 * Provides:
 *   sparql.query(queryString, opts?) — execute SELECT/CONSTRUCT/DESCRIBE; returns parsed bindings array
 *   sparql.ask(queryString)          — execute ASK; returns boolean
 *   sparql.raw(queryString, opts?)   — execute and return the unparsed JSON envelope
 *   prefixes                         — object of common ontology prefixes
 *   prefixHeader                     — pre-built `PREFIX ...` block as a string
 *   api.query(dataAccessId, sql), db.queryStaged, db.stage — staging helpers
 *
 * The endpoint URL never enters the isolate — all HTTP goes through the host's
 * sparqlFetch via the codemode.__sparql_proxy bridge.
 */

export function buildSparqlProxySource(): string {
	return `
// --- SPARQL proxy helpers (injected) ---

function __wrapStaged(raw) {
  __stagedResults.push(raw);
  var msg = raw.message || "Response was auto-staged.";
  var hint = " Return this object and use the query_data tool with data_access_id=\\"" +
    raw.data_access_id + "\\" to query it with SQL.";
  var TRAP_KEYS = ["bindings", "results", "data", "rows", "records"];
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

async function __stageData(data, tableNameOrOptions) {
  if (data === undefined || data === null) throw new Error("db.stage() requires data");
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

/** Flatten a SPARQL JSON binding into a plain { variable: value } row. */
function __flattenBinding(binding) {
  var row = {};
  for (var k in binding) {
    if (Object.prototype.hasOwnProperty.call(binding, k)) {
      row[k] = binding[k] && binding[k].value !== undefined ? binding[k].value : null;
    }
  }
  return row;
}

var sparql = {
  /**
   * Execute a SPARQL query. Returns an array of plain rows for SELECT,
   * triples object for CONSTRUCT/DESCRIBE, or throws on syntax error.
   *
   *   const rows = await sparql.query('SELECT ?gene WHERE { ?gene a obo:SO_0000704 } LIMIT 10');
   *   // rows = [{ gene: "..." }, ...]
   *
   * Pass { raw: true } to get the unparsed JSON envelope { head, results }.
   */
  query: async function(query, opts) {
    var options = opts || {};
    var result = await codemode.__sparql_proxy({
      query: query,
      method: options.method || "POST",
      format: options.format || "json",
      timeoutMs: options.timeoutMs || 60000,
    });
    if (result && result.__sparql_error) {
      var err = new Error("SPARQL error: " + result.message);
      err.code = result.code;
      throw err;
    }
    if (result && result.__staged) {
      return __wrapStaged(result);
    }
    if (options.raw) return result;
    if (result && result.boolean !== undefined) return result.boolean;
    if (result && result.results && Array.isArray(result.results.bindings)) {
      return result.results.bindings.map(__flattenBinding);
    }
    return result;
  },

  /**
   * Execute an ASK query. Returns true/false.
   */
  ask: async function(query) {
    var result = await codemode.__sparql_proxy({
      query: query,
      method: "POST",
      format: "json",
      timeoutMs: 30000,
    });
    if (result && result.__sparql_error) {
      var err = new Error("SPARQL error: " + result.message);
      throw err;
    }
    return result && result.boolean === true;
  },

  /**
   * Get the raw JSON envelope (head + results) — useful for inspecting
   * datatypes/languages on bindings, or returning to the client verbatim.
   */
  raw: async function(query, opts) {
    var merged = {};
    if (opts) for (var k in opts) merged[k] = opts[k];
    merged.raw = true;
    return sparql.query(query, merged);
  },
};

var api = {
  query: function(dataAccessId, sql) { return __queryStaged(dataAccessId, sql); },
};

var db = {
  queryStaged: function(dataAccessId, sql) { return __queryStaged(dataAccessId, sql); },
  stage: function(data, tableNameOrOptions) { return __stageData(data, tableNameOrOptions); },
};
// --- End SPARQL proxy helpers ---
`;
}
