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
export function buildOpenApiSearchSource(specJson) {
    return `
// --- OpenAPI search helpers (injected) ---
var spec = Object.freeze(JSON.parse(${JSON.stringify(specJson)}));
var SPEC = spec;

var __HTTP_METHODS = ["get", "post", "put", "delete", "patch", "options", "head", "trace"];

/**
 * Collect all operations from the spec into a flat list.
 * Each entry has: path, method, and all operation-level fields.
 */
function __collectOperations() {
  var ops = [];
  var paths = spec.paths || {};
  var pathKeys = Object.keys(paths);
  for (var i = 0; i < pathKeys.length; i++) {
    var pathStr = pathKeys[i];
    var pathItem = paths[pathStr];
    if (!pathItem || typeof pathItem !== "object") continue;
    for (var j = 0; j < __HTTP_METHODS.length; j++) {
      var method = __HTTP_METHODS[j];
      var op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      var entry = { path: pathStr, method: method };
      var opKeys = Object.keys(op);
      for (var k = 0; k < opKeys.length; k++) {
        entry[opKeys[k]] = op[opKeys[k]];
      }
      ops.push(entry);
    }
  }
  return ops;
}

/**
 * Search operations by keyword query. Tokenizes the query and scores
 * each operation by how many tokens match in path, summary, description,
 * tags, operationId, and parameter names/descriptions.
 *
 * With an empty query, returns all operations (up to maxResults).
 */
function searchPaths(query, maxResults) {
  if (maxResults === undefined) maxResults = 10;
  var ops = __collectOperations();

  if (!query || query.trim() === "") {
    return ops.slice(0, maxResults);
  }

  var tokens = query.toLowerCase().split(/\\s+/).filter(function(t) { return t.length > 0; });
  if (tokens.length === 0) return ops.slice(0, maxResults);

  var scored = [];
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    var textParts = [
      op.path || "",
      op.method || "",
      op.summary || "",
      op.description || "",
      op.operationId || "",
      (op.tags || []).join(" "),
    ];

    // Include parameter names and descriptions
    var params = op.parameters;
    if (params && Array.isArray(params)) {
      for (var p = 0; p < params.length; p++) {
        var param = params[p];
        if (param.name) textParts.push(param.name);
        if (param.description) textParts.push(param.description);
      }
    }

    var text = textParts.join(" ").toLowerCase();

    var score = 0;
    for (var t = 0; t < tokens.length; t++) {
      if (text.indexOf(tokens[t]) !== -1) score++;
    }

    if (score > 0) {
      scored.push({ op: op, score: score });
    }
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  var results = [];
  var limit = Math.min(scored.length, maxResults);
  for (var r = 0; r < limit; r++) {
    results.push(scored[r].op);
  }
  return results;
}

/**
 * List all tags across all operations with their counts.
 */
function listTags() {
  var ops = __collectOperations();
  var tagCounts = {};
  for (var i = 0; i < ops.length; i++) {
    var tags = ops[i].tags;
    if (!tags || !Array.isArray(tags)) continue;
    for (var j = 0; j < tags.length; j++) {
      var tag = tags[j];
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  var result = [];
  var keys = Object.keys(tagCounts);
  for (var k = 0; k < keys.length; k++) {
    result.push({ tag: keys[k], count: tagCounts[keys[k]] });
  }
  return result;
}

/**
 * Get an operation by operationId or by path string.
 * Returns { path, method, ...operationFields } or null.
 */
function getOperation(idOrPath) {
  var ops = __collectOperations();

  // First try to match by operationId
  for (var i = 0; i < ops.length; i++) {
    if (ops[i].operationId === idOrPath) return ops[i];
  }

  // Then try to match by path (returns first method found)
  for (var j = 0; j < ops.length; j++) {
    if (ops[j].path === idOrPath) return ops[j];
  }

  return null;
}

/**
 * Get an operation by path and optional method, matching the legacy
 * catalog helper shape used inside execute().
 */
function __getOperationByPathAndMethod(path, method) {
  var ops = __collectOperations();
  var normalizedMethod = method ? String(method).toLowerCase() : null;

  for (var i = 0; i < ops.length; i++) {
    if (ops[i].path !== path) continue;
    if (!normalizedMethod || ops[i].method === normalizedMethod) return ops[i];
  }

  return null;
}

function __describeOperation(op, missingLabel) {
  if (!op) return missingLabel;

  var lines = [
    op.method.toUpperCase() + " " + op.path,
  ];

  if (op.operationId) lines.push("Operation ID: " + op.operationId);
  if (op.summary) lines.push("Summary: " + op.summary);
  if (op.description) lines.push("Description: " + op.description);
  if (op.tags && op.tags.length > 0) lines.push("Tags: " + op.tags.join(", "));

  var params = op.parameters;
  if (params && Array.isArray(params) && params.length > 0) {
    lines.push("Parameters:");
    for (var i = 0; i < params.length; i++) {
      var p = params[i];
      var paramType = "unknown";
      if (p.schema && p.schema.type) paramType = p.schema.type;
      else if (p.type) paramType = p.type;
      var line = "  " + p.name + " (" + p.in + ", " + paramType;
      if (p.required) line += ", required";
      line += ")";
      if (p.description) line += " — " + p.description;
      lines.push(line);
    }
  }

  var responses = op.responses;
  if (responses && typeof responses === "object") {
    var respKeys = Object.keys(responses);
    if (respKeys.length > 0) {
      lines.push("Responses:");
      for (var r = 0; r < respKeys.length; r++) {
        var code = respKeys[r];
        var resp = responses[code];
        var desc = resp && resp.description ? resp.description : "";
        lines.push("  " + code + ": " + desc);
      }
    }
  }

  return lines.join("\\n");
}

/**
 * Format an operation as readable documentation.
 */
function describeOperation(idOrPath) {
  var op = getOperation(idOrPath);
  return __describeOperation(op, "Operation not found: " + idOrPath);
}

// Legacy aliases used by existing execute() prompts/descriptions.
function searchSpec(query, maxResults) {
  return searchPaths(query, maxResults);
}

function listCategories() {
  return listTags().map(function(entry) {
    return { category: entry.tag, count: entry.count };
  });
}

function getEndpoint(path, method) {
  return __getOperationByPathAndMethod(path, method);
}

function describeEndpoint(path, method) {
  var op = __getOperationByPathAndMethod(path, method);
  var label = "Endpoint not found: " + ((method || "GET").toUpperCase()) + " " + path;
  return __describeOperation(op, label);
}
// --- End OpenAPI search helpers ---
`;
}
//# sourceMappingURL=openapi-search.js.map