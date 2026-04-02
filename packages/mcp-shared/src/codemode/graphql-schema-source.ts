/**
 * GraphQL schema source — pure JS injected into V8 isolates.
 *
 * Provides schema.types(), schema.type(), schema.search(),
 * schema.queryRoot(), schema.mutationRoot(), schema.inputType(),
 * and schema.enumValues() functions that operate on the frozen
 * SCHEMA object (trimmed introspection data).
 */

/**
 * Returns the JS source string to inject into V8 isolates.
 * The introspection JSON is embedded as a frozen global `SCHEMA`.
 */
export function buildGraphqlSchemaSource(introspectionJson: string): string {
	return `
// --- GraphQL schema helpers (injected) ---
var SCHEMA = Object.freeze(JSON.parse(${JSON.stringify(introspectionJson)}));

var __typeMap = {};
for (var __i = 0; __i < SCHEMA.types.length; __i++) {
  __typeMap[SCHEMA.types[__i].name] = SCHEMA.types[__i];
}
Object.freeze(__typeMap);

var schema = {
  /**
   * List all types, optionally filtered by kind.
   * schema.types()            -> all types
   * schema.types("OBJECT")    -> only object types
   * schema.types("ENUM")      -> only enums
   * schema.types("INPUT_OBJECT") -> only input types
   */
  types: function(kindFilter) {
    var result = [];
    for (var i = 0; i < SCHEMA.types.length; i++) {
      var t = SCHEMA.types[i];
      if (!kindFilter || t.kind === kindFilter) {
        result.push({ name: t.name, kind: t.kind, description: t.description || null });
      }
    }
    return result;
  },

  /**
   * Get full type info by name. Returns null if not found.
   * schema.type("Gene") -> { name, kind, description, fields, ... }
   */
  type: function(name) {
    return __typeMap[name] || null;
  },

  /**
   * Fuzzy search across type names, field names, and descriptions.
   * Returns matches ranked by relevance.
   * schema.search("gene")        -> types/fields matching "gene"
   * schema.search("variant", 5)  -> top 5 matches
   */
  search: function(query, maxResults) {
    if (!maxResults) maxResults = 15;
    var tokens = query.toLowerCase().split(/\\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    var scored = [];

    for (var i = 0; i < SCHEMA.types.length; i++) {
      var t = SCHEMA.types[i];
      var typeName = t.name.toLowerCase();
      var typeDesc = (t.description || "").toLowerCase();

      // Score the type itself
      var typeScore = 0;
      for (var ti = 0; ti < tokens.length; ti++) {
        if (typeName.indexOf(tokens[ti]) !== -1) typeScore += 3;
        if (typeDesc.indexOf(tokens[ti]) !== -1) typeScore += 1;
      }
      if (typeScore > 0) {
        scored.push({ type: t.name, field: null, score: typeScore, kind: t.kind });
      }

      // Score fields
      var fields = t.fields || [];
      for (var fi = 0; fi < fields.length; fi++) {
        var f = fields[fi];
        var fieldName = f.name.toLowerCase();
        var fieldDesc = (f.description || "").toLowerCase();
        var fieldScore = 0;
        for (var fti = 0; fti < tokens.length; fti++) {
          if (fieldName.indexOf(tokens[fti]) !== -1) fieldScore += 2;
          if (fieldDesc.indexOf(tokens[fti]) !== -1) fieldScore += 1;
        }
        if (fieldScore > 0) {
          scored.push({ type: t.name, field: f.name, fieldType: f.type, score: fieldScore });
        }
      }
    }

    scored.sort(function(a, b) { return b.score - a.score; });
    return scored.slice(0, maxResults);
  },

  /**
   * Get top-level Query type fields with their args and return types.
   * schema.queryRoot() -> [{ name, args, returnType, description }, ...]
   */
  queryRoot: function() {
    var qt = __typeMap[SCHEMA.queryType.name];
    if (!qt || !qt.fields) return [];
    return qt.fields.map(function(f) {
      return {
        name: f.name,
        args: f.args || [],
        returnType: f.type,
        description: f.description || null,
      };
    });
  },

  /**
   * Get top-level Mutation type fields (if mutation type exists).
   * schema.mutationRoot() -> [{ name, args, returnType, description }, ...]
   */
  mutationRoot: function() {
    if (!SCHEMA.mutationType) return [];
    var mt = __typeMap[SCHEMA.mutationType.name];
    if (!mt || !mt.fields) return [];
    return mt.fields.map(function(f) {
      return {
        name: f.name,
        args: f.args || [],
        returnType: f.type,
        description: f.description || null,
      };
    });
  },

  /**
   * Get input object fields by type name.
   * schema.inputType("TargetInput") -> [{ name, type, defaultValue }, ...]
   */
  inputType: function(name) {
    var t = __typeMap[name];
    if (!t || !t.inputFields) return null;
    return t.inputFields;
  },

  /**
   * Get enum values for an enum type.
   * schema.enumValues("EvidenceLevel") -> [{ name, description }, ...]
   */
  enumValues: function(name) {
    var t = __typeMap[name];
    if (!t || !t.enumValues) return null;
    return t.enumValues;
  },
};
// --- End GraphQL schema helpers ---
`;
}
