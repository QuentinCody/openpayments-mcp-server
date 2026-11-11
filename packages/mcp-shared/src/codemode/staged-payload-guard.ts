/** Shared isolate-side guard for serialized auto-staging envelopes. */

const STAGED_PAYLOAD_KEYS = [
	"resultList",
	"results",
	"result",
	"data",
	"bindings",
	"items",
	"hits",
	"records",
	"rows",
	"response",
	"collection",
	"content",
	"_embedded",
	"docs",
	"entries",
	"studies",
	"nodes",
	"edges",
] as const;

const ARRAY_METHODS = [
	"slice",
	"map",
	"filter",
	"forEach",
	"reduce",
	"reduceRight",
	"find",
	"findIndex",
	"some",
	"every",
	"flatMap",
	"flat",
	"sort",
	"reverse",
	"concat",
	"join",
	"indexOf",
	"lastIndexOf",
	"includes",
	"at",
	"pop",
	"push",
	"shift",
	"unshift",
	"splice",
	"fill",
	"keys",
	"values",
	"entries",
] as const;

/**
 * JavaScript injected into every REST, GraphQL, and SPARQL Code Mode isolate.
 * Host-side accessors cannot survive JSON-RPC serialization, so the proxy is
 * restored at the point where the serialized envelope enters user code.
 */
export const STAGED_PAYLOAD_GUARD_SOURCE = `
// --- Shared staged-payload guard (injected) ---
var __STAGED_PAYLOAD_KEYS = ${JSON.stringify(STAGED_PAYLOAD_KEYS)};
var __STAGED_ARRAY_METHODS = ${JSON.stringify(ARRAY_METHODS)};

function __stagedPayloadAccessError(raw, prop, arrayMethod) {
  var rows = raw.total_rows != null ? raw.total_rows + " rows" : "large payload";
  var handle = raw.data_access_id || "";
  var access = arrayMethod ? "." + prop + "()" : "'" + prop + "'";
  var err = new Error(
    "This response was AUTO-STAGED (" + rows + ") — " + access +
    " is not available on the staging envelope. STAGED rows live in SQLite; this is not an empty result. " +
    "Use api.query('" + handle + "', 'SELECT * FROM <table> LIMIT 10') or return the envelope."
  );
  err.name = "StagedPayloadAccessError";
  err.code = "STAGED_PAYLOAD_ACCESS";
  err.property = prop;
  err.data_access_id = handle;
  return err;
}

function __wrapStaged(raw) {
  __stagedResults.push(raw);
  return new Proxy(raw, {
    get: function(target, prop) {
      if (typeof prop !== "string" || prop in target) return target[prop];
      if (__STAGED_PAYLOAD_KEYS.indexOf(prop) !== -1) {
        throw __stagedPayloadAccessError(raw, prop, false);
      }
      if (__STAGED_ARRAY_METHODS.indexOf(prop) !== -1) {
        return function() { throw __stagedPayloadAccessError(raw, prop, true); };
      }
      return target[prop];
    }
  });
}
// --- End shared staged-payload guard ---
`;
