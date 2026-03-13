/**
 * Catalog Generator — converts API specifications to ApiCatalog format.
 *
 * Supports four tiers of API documentation:
 *   Tier 1: OpenAPI 3.x (via ResolvedSpec from openapi-resolver.ts)
 *   Tier 2: Swagger 2.x (resolve first, then same as Tier 1)
 *   Tier 3: GraphQL introspection results
 *   Tier 4: Manual JSON/YAML definitions
 *
 * All tiers support an override system for enrichment.
 */
// ── Schema → Response Shape ──────────────────────────────────────────────
const MAX_SHAPE_DEPTH = 4;
const MAX_SHAPE_PROPERTIES = 12;
/**
 * Convert an OpenAPI/JSON-Schema object to a TypeScript-like shape string.
 * E.g. `{ id: string, items: Array<{ name: string, count: number }> }`
 */
export function schemaToResponseShape(schema, depth = 0) {
    if (!schema || typeof schema !== "object" || depth > MAX_SHAPE_DEPTH)
        return "any";
    const s = schema;
    // Union types
    if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
        const variants = (s.oneOf || s.anyOf);
        return variants
            .slice(0, 4)
            .map((v) => schemaToResponseShape(v, depth + 1))
            .join(" | ");
    }
    // Intersection/composition
    if (Array.isArray(s.allOf)) {
        const merged = { type: "object", properties: {}, required: [] };
        for (const sub of s.allOf) {
            if (sub.properties && typeof sub.properties === "object") {
                Object.assign(merged.properties, sub.properties);
            }
            if (Array.isArray(sub.required)) {
                merged.required.push(...sub.required);
            }
        }
        return schemaToResponseShape(merged, depth);
    }
    // Enums
    if (Array.isArray(s.enum)) {
        return s.enum.map((v) => JSON.stringify(v)).join(" | ");
    }
    switch (s.type) {
        case "string":
            return "string";
        case "integer":
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "array": {
            const items = s.items ? schemaToResponseShape(s.items, depth + 1) : "any";
            return `Array<${items}>`;
        }
        case "object":
        default: {
            if (s.type && s.type !== "object" && !s.properties)
                return "any";
            const props = s.properties;
            if (!props || typeof props !== "object") {
                if (s.additionalProperties && typeof s.additionalProperties === "object") {
                    return `Record<string, ${schemaToResponseShape(s.additionalProperties, depth + 1)}>`;
                }
                return s.properties === undefined && !s.type ? "any" : "object";
            }
            const entries = Object.entries(props);
            const required = new Set(Array.isArray(s.required) ? s.required : []);
            const parts = entries.slice(0, MAX_SHAPE_PROPERTIES).map(([key, val]) => {
                const opt = required.has(key) ? "" : "?";
                return `${key}${opt}: ${schemaToResponseShape(val, depth + 1)}`;
            });
            const ellipsis = entries.length > MAX_SHAPE_PROPERTIES ? ", ..." : "";
            return `{ ${parts.join(", ")}${ellipsis} }`;
        }
    }
}
// ── Parameter Helpers ────────────────────────────────────────────────────
function mapSchemaType(schema) {
    if (!schema || typeof schema !== "object")
        return "string";
    const s = schema;
    const type = s.type;
    switch (type) {
        case "integer":
        case "number":
        case "float":
        case "double":
            return "number";
        case "boolean":
            return "boolean";
        case "array":
            return "array";
        default:
            return "string";
    }
}
function extractParam(raw, location) {
    if (raw.in !== location)
        return null;
    const schema = (raw.schema || {});
    const param = {
        name: String(raw.name || ""),
        type: mapSchemaType(schema.type ? schema : raw),
        required: location === "path" ? true : Boolean(raw.required),
        description: String(raw.description || schema.description || raw.name || ""),
    };
    const def = raw.default ?? schema.default;
    if (def !== undefined)
        param.default = def;
    const enm = (raw.enum || schema.enum);
    if (enm?.length)
        param.enum = enm;
    return param;
}
// ── Category Derivation ──────────────────────────────────────────────────
function deriveCategory(operation, pathStr, strategy) {
    switch (strategy) {
        case "tag": {
            const tags = operation.tags;
            return tags?.[0]?.toLowerCase().replace(/\s+/g, "_") || "general";
        }
        case "path-prefix": {
            const segments = pathStr.split("/").filter(Boolean);
            const meaningful = segments.find((s) => !/^(v\d+|api|rest|json)$/i.test(s) && !s.startsWith("{"));
            return meaningful?.toLowerCase() || "general";
        }
        case "operationId": {
            const id = (operation.operationId || "");
            const match = id.match(/^(?:get|post|put|delete|list|create|update|search|find)(.+)/i);
            if (match) {
                return match[1]
                    .replace(/([A-Z])/g, "_$1")
                    .toLowerCase()
                    .replace(/^_/, "")
                    .split("_")[0];
            }
            return "general";
        }
    }
}
// ── OpenAPI → ApiCatalog (Tier 1/2) ─────────────────────────────────────
const SUPPORTED_METHODS = new Set(["get", "post", "put", "delete"]);
const SKIPPED_METHODS = new Set(["options", "head", "trace"]);
/**
 * Convert a resolved (ref-free) OpenAPI spec to an ApiCatalog.
 * Swagger 2.x specs should be resolved via `resolveOpenApiSpec()` first,
 * which auto-converts them to OpenAPI 3.0 format.
 */
export function openApiToCatalog(spec, options) {
    const opts = options || {};
    const strategy = opts.categoryStrategy || "tag";
    const includeExamples = opts.includeExamples ?? false;
    const includeDeprecated = opts.includeDeprecated ?? true;
    const diagnostics = [];
    const endpoints = [];
    for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
        if (!pathItem || typeof pathItem !== "object")
            continue;
        const pathRecord = pathItem;
        // Path-level parameters
        const pathLevelParams = Array.isArray(pathRecord.parameters)
            ? pathRecord.parameters
            : [];
        for (const [method, value] of Object.entries(pathRecord)) {
            if (!value || typeof value !== "object")
                continue;
            // Handle PATCH → PUT mapping
            if (method === "patch") {
                const op = value;
                const mappedRecord = {
                    ...pathRecord,
                    put: {
                        ...op,
                        description: op.description
                            ? `[Originally PATCH] ${op.description}`
                            : "[Originally PATCH]",
                    },
                };
                // Process as PUT (recursive single-endpoint extraction)
                const pathParams = Array.isArray(pathRecord.parameters) ? pathRecord.parameters : [];
                const opParams = Array.isArray(op.parameters) ? op.parameters : [];
                const allParams = [...pathLevelParams, ...opParams];
                const endpoint = buildEndpointFromOperation("PUT", pathStr, {
                    ...op,
                    description: op.description
                        ? `[Originally PATCH] ${op.description}`
                        : "[Originally PATCH]",
                }, allParams, strategy, includeExamples);
                if (endpoint) {
                    if (op.deprecated && !includeDeprecated) {
                        diagnostics.push({
                            level: "info",
                            message: "Skipped deprecated PATCH endpoint (mapped to PUT)",
                            path: pathStr,
                            method: "PATCH",
                        });
                    }
                    else {
                        if (op.deprecated)
                            endpoint.deprecated = true;
                        endpoints.push(endpoint);
                        diagnostics.push({
                            level: "info",
                            message: "Mapped PATCH to PUT",
                            path: pathStr,
                            method: "PATCH",
                        });
                    }
                }
                continue;
            }
            if (SKIPPED_METHODS.has(method)) {
                diagnostics.push({
                    level: "info",
                    message: `Skipped ${method.toUpperCase()} (not supported in ApiEndpoint)`,
                    path: pathStr,
                    method: method.toUpperCase(),
                });
                continue;
            }
            if (!SUPPORTED_METHODS.has(method))
                continue;
            const op = value;
            if (op.deprecated && !includeDeprecated) {
                diagnostics.push({
                    level: "info",
                    message: "Skipped deprecated endpoint",
                    path: pathStr,
                    method: method.toUpperCase(),
                });
                continue;
            }
            const opParams = Array.isArray(op.parameters)
                ? op.parameters
                : [];
            const allParams = mergeParams(pathLevelParams, opParams);
            const endpoint = buildEndpointFromOperation(method.toUpperCase(), pathStr, op, allParams, strategy, includeExamples);
            if (endpoint) {
                if (op.deprecated)
                    endpoint.deprecated = true;
                endpoints.push(endpoint);
            }
        }
    }
    // Sort by category then path
    endpoints.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
    // Derive base URL
    const specBaseUrl = spec.servers?.[0]?.url || "";
    const catalog = {
        name: opts.name || spec.info.title || "API",
        baseUrl: (opts.baseUrl || specBaseUrl).replace(/\/$/, ""),
        ...(spec.info.version ? { version: opts.name ? spec.info.version : spec.info.version } : {}),
        endpointCount: endpoints.length,
        ...(opts.auth ? { auth: opts.auth } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
        endpoints,
    };
    return { catalog, diagnostics };
}
function mergeParams(pathLevel, opLevel) {
    const map = new Map();
    for (const p of pathLevel)
        map.set(`${p.in}:${p.name}`, p);
    for (const p of opLevel)
        map.set(`${p.in}:${p.name}`, p); // op-level overrides
    return Array.from(map.values());
}
function buildEndpointFromOperation(method, pathStr, op, allParams, strategy, includeExamples) {
    const summary = String(op.summary || op.operationId || `${method} ${pathStr}`);
    const pathParams = allParams
        .map((p) => extractParam(p, "path"))
        .filter((p) => p !== null);
    const queryParams = allParams
        .map((p) => extractParam(p, "query"))
        .filter((p) => p !== null);
    // Extract body
    let body;
    const requestBody = op.requestBody;
    if (requestBody?.content && typeof requestBody.content === "object") {
        const contentTypes = Object.keys(requestBody.content);
        const contentType = contentTypes[0] || "application/json";
        body = {
            contentType,
            ...(requestBody.description ? { description: String(requestBody.description) } : {}),
        };
    }
    // Extract response shape
    let responseShape;
    let responseDesc;
    let responseExample;
    const responses = op.responses;
    if (responses) {
        const successKey = ["200", "201"].find((k) => responses[k]) ||
            Object.keys(responses).find((k) => k.startsWith("2"));
        if (successKey) {
            const resp = responses[successKey];
            responseDesc = resp.description;
            const content = resp.content;
            if (content) {
                const mediaType = (content["application/json"] ||
                    Object.values(content)[0]);
                if (mediaType?.schema) {
                    responseShape = schemaToResponseShape(mediaType.schema);
                    if (responseShape === "any" || responseShape === "object") {
                        responseShape = undefined; // Not informative enough
                    }
                }
                if (includeExamples && mediaType?.example) {
                    responseExample = mediaType.example;
                }
            }
        }
    }
    const description = op.description;
    const category = deriveCategory(op, pathStr, strategy);
    const endpoint = {
        method,
        path: pathStr,
        summary,
        ...(description && description !== summary ? { description } : {}),
        category,
        ...(pathParams.length > 0 ? { pathParams } : {}),
        ...(queryParams.length > 0 ? { queryParams } : {}),
        ...(body ? { body } : {}),
        ...(responseShape ? { responseShape } : {}),
    };
    // Build response field
    if (responseDesc || responseExample) {
        endpoint.response = {
            ...(responseDesc ? { description: responseDesc } : {}),
            ...(responseExample !== undefined ? { example: responseExample } : {}),
        };
    }
    return endpoint;
}
function unwrapGqlType(type) {
    let required = false;
    let isList = false;
    let current = type;
    if (current.kind === "NON_NULL") {
        required = true;
        current = current.ofType || current;
    }
    if (current.kind === "LIST") {
        isList = true;
        current = current.ofType || current;
        if (current.kind === "NON_NULL") {
            current = current.ofType || current;
        }
    }
    return { typeName: current.name || "any", required, isList };
}
function gqlTypeToParamType(type) {
    const { typeName, isList } = unwrapGqlType(type);
    if (isList)
        return "array";
    switch (typeName) {
        case "Int":
        case "Float":
            return "number";
        case "Boolean":
            return "boolean";
        default:
            return "string";
    }
}
function gqlTypeToShapeString(type) {
    const { typeName, isList } = unwrapGqlType(type);
    const scalar = typeName === "Int" || typeName === "Float"
        ? "number"
        : typeName === "Boolean"
            ? "boolean"
            : typeName === "String" || typeName === "ID"
                ? "string"
                : typeName;
    return isList ? `Array<${scalar}>` : scalar;
}
/**
 * Convert a GraphQL introspection result to an ApiCatalog.
 * Each query becomes a virtual GET endpoint, each mutation a POST endpoint.
 * Arguments are mapped to queryParams for discoverability.
 */
export function graphQlToCatalog(introspection, options) {
    const diagnostics = [];
    const endpoints = [];
    // Navigate to __schema
    const root = introspection;
    const schema = root.__schema ||
        root.data?.__schema;
    if (!schema) {
        return {
            catalog: {
                name: options.name,
                baseUrl: options.baseUrl,
                endpointCount: 0,
                endpoints: [],
            },
            diagnostics: [{ level: "error", message: "No __schema found in introspection result" }],
        };
    }
    const types = schema.types;
    if (!types) {
        return {
            catalog: { name: options.name, baseUrl: options.baseUrl, endpointCount: 0, endpoints: [] },
            diagnostics: [{ level: "error", message: "No types found in schema" }],
        };
    }
    const queryTypeName = schema.queryType?.name;
    const mutationTypeName = schema.mutationType?.name;
    // Process queries
    if (queryTypeName) {
        const queryType = types.find((t) => t.name === queryTypeName);
        const fields = queryType?.fields;
        if (fields) {
            for (const field of fields) {
                if (field.name.startsWith("__"))
                    continue; // Skip introspection fields
                const queryParams = field.args.length > 0
                    ? field.args.map((arg) => ({
                        name: arg.name,
                        type: gqlTypeToParamType(arg.type),
                        required: unwrapGqlType(arg.type).required,
                        description: arg.description || arg.name,
                        ...(arg.defaultValue != null ? { default: arg.defaultValue } : {}),
                    }))
                    : undefined;
                const requiredArgs = field.args
                    .filter((a) => unwrapGqlType(a.type).required)
                    .map((a) => `${a.name}: $${a.name}`)
                    .join(", ");
                endpoints.push({
                    method: "POST",
                    path: "/graphql",
                    summary: `Query: ${field.name}${field.description ? ` — ${field.description}` : ""}`,
                    ...(field.description ? { description: field.description } : {}),
                    category: "queries",
                    ...(queryParams ? { queryParams } : {}),
                    body: { contentType: "application/json", description: "GraphQL query" },
                    responseShape: gqlTypeToShapeString(field.type),
                    usageHint: `api.post('/graphql', { query: '{ ${field.name}${requiredArgs ? `(${requiredArgs})` : ""} { ... } }' })`,
                    ...(field.isDeprecated ? { deprecated: true } : {}),
                });
            }
        }
    }
    // Process mutations
    if (mutationTypeName) {
        const mutationType = types.find((t) => t.name === mutationTypeName);
        const fields = mutationType?.fields;
        if (fields) {
            for (const field of fields) {
                if (field.name.startsWith("__"))
                    continue;
                endpoints.push({
                    method: "POST",
                    path: "/graphql",
                    summary: `Mutation: ${field.name}${field.description ? ` — ${field.description}` : ""}`,
                    ...(field.description ? { description: field.description } : {}),
                    category: "mutations",
                    body: { contentType: "application/json", description: "GraphQL mutation" },
                    responseShape: gqlTypeToShapeString(field.type),
                    ...(field.isDeprecated ? { deprecated: true } : {}),
                });
            }
        }
    }
    if (endpoints.length === 0) {
        diagnostics.push({ level: "warn", message: "No queries or mutations found in schema" });
    }
    const catalog = {
        name: options.name,
        baseUrl: options.baseUrl,
        endpointCount: endpoints.length,
        ...(options.auth ? { auth: options.auth } : {}),
        notes: options.notes ||
            "GraphQL API. All operations use POST /graphql with { query: '...' } body. " +
                "Use api.post('/graphql', { query: '...' }) in Code Mode.",
        endpoints,
    };
    return { catalog, diagnostics };
}
// ── Manual Definition → ApiCatalog (Tier 4) ──────────────────────────────
/**
 * Validate and normalize a manually-defined catalog from JSON/YAML.
 * Fills in defaults, normalizes types, and sets endpointCount.
 */
export function normalizeManualCatalog(raw) {
    const diagnostics = [];
    if (!raw || typeof raw !== "object") {
        return {
            catalog: { name: "API", baseUrl: "", endpointCount: 0, endpoints: [] },
            diagnostics: [{ level: "error", message: "Manual catalog must be an object" }],
        };
    }
    const def = raw;
    const rawEndpoints = Array.isArray(def.endpoints) ? def.endpoints : [];
    const endpoints = rawEndpoints.map((ep, i) => {
        if (!ep || typeof ep !== "object") {
            diagnostics.push({ level: "warn", message: `Endpoint ${i} is not an object, skipped` });
            return null;
        }
        const e = ep;
        const method = String(e.method || "GET").toUpperCase();
        if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
            diagnostics.push({
                level: "warn",
                message: `Endpoint ${i} has unsupported method "${method}", defaulting to GET`,
            });
        }
        return {
            method: (["GET", "POST", "PUT", "DELETE"].includes(method)
                ? method
                : "GET"),
            path: String(e.path || "/"),
            summary: String(e.summary || ""),
            ...(e.description ? { description: String(e.description) } : {}),
            category: String(e.category || "general"),
            ...(Array.isArray(e.pathParams) ? { pathParams: e.pathParams.map(normalizeParam) } : {}),
            ...(Array.isArray(e.queryParams)
                ? { queryParams: e.queryParams.map(normalizeParam) }
                : {}),
            ...(e.body && typeof e.body === "object" ? { body: e.body } : {}),
            ...(e.response && typeof e.response === "object"
                ? { response: e.response }
                : {}),
            ...(e.responseShape ? { responseShape: String(e.responseShape) } : {}),
            ...(e.coveredByTool ? { coveredByTool: String(e.coveredByTool) } : {}),
            ...(e.deprecated ? { deprecated: true } : {}),
            ...(e.example ? { example: String(e.example) } : {}),
            ...(e.usageHint ? { usageHint: String(e.usageHint) } : {}),
        };
    }).filter(Boolean);
    const catalog = {
        name: String(def.name || "API"),
        baseUrl: String(def.baseUrl || ""),
        ...(def.version ? { version: String(def.version) } : {}),
        endpointCount: endpoints.length,
        ...(def.auth ? { auth: String(def.auth) } : {}),
        ...(def.notes ? { notes: String(def.notes) } : {}),
        endpoints,
        ...(Array.isArray(def.workflows) ? { workflows: def.workflows } : {}),
    };
    return { catalog, diagnostics };
}
function normalizeParam(p) {
    if (!p || typeof p !== "object") {
        return { name: "", type: "string", required: false, description: "" };
    }
    const raw = p;
    return {
        name: String(raw.name || ""),
        type: (["string", "number", "boolean", "array"].includes(String(raw.type))
            ? String(raw.type)
            : "string"),
        required: Boolean(raw.required),
        description: String(raw.description || ""),
        ...(raw.default !== undefined ? { default: raw.default } : {}),
        ...(Array.isArray(raw.enum) ? { enum: raw.enum } : {}),
    };
}
// ── Override System ──────────────────────────────────────────────────────
/**
 * Apply overrides to a generated catalog. Works identically regardless of
 * which tier produced the catalog.
 */
export function applyOverrides(catalog, overrides) {
    const diagnostics = [];
    let endpoints = [...catalog.endpoints];
    // Path-level exclusions
    if (overrides.exclude?.length) {
        const excludeSet = new Set(overrides.exclude);
        const before = endpoints.length;
        endpoints = endpoints.filter((ep) => !excludeSet.has(ep.path));
        diagnostics.push({
            level: "info",
            message: `Excluded ${before - endpoints.length} endpoints by path`,
        });
    }
    // Path-level allowlist
    if (overrides.include?.length) {
        const includeSet = new Set(overrides.include);
        const before = endpoints.length;
        endpoints = endpoints.filter((ep) => includeSet.has(ep.path));
        diagnostics.push({
            level: "info",
            message: `Filtered to ${endpoints.length} endpoints by allowlist (removed ${before - endpoints.length})`,
        });
    }
    // Category mapping
    if (overrides.categoryMap) {
        const map = overrides.categoryMap;
        endpoints = endpoints.map((ep) => ({
            ...ep,
            category: map[ep.category] || ep.category,
        }));
    }
    // Per-endpoint overrides
    const matchedKeys = new Set();
    if (overrides.endpoints) {
        endpoints = endpoints
            .map((ep) => {
            const key = `${ep.method} ${ep.path}`;
            const override = overrides.endpoints[key];
            if (!override)
                return ep;
            matchedKeys.add(key);
            if (override.exclude) {
                diagnostics.push({ level: "info", message: `Excluded: ${key}` });
                return null;
            }
            // Shallow merge — override fields replace, undefined fields keep original
            const { exclude: _, ...fields } = override;
            return { ...ep, ...fields };
        })
            .filter((ep) => ep !== null);
        // Warn about unmatched override keys
        for (const key of Object.keys(overrides.endpoints)) {
            if (!matchedKeys.has(key) && !overrides.endpoints[key].exclude) {
                diagnostics.push({
                    level: "warn",
                    message: `Override key "${key}" did not match any endpoint`,
                });
            }
        }
    }
    // Additional endpoints
    if (overrides.additionalEndpoints?.length) {
        endpoints.push(...overrides.additionalEndpoints);
        diagnostics.push({
            level: "info",
            message: `Added ${overrides.additionalEndpoints.length} additional endpoints`,
        });
    }
    // Build result catalog
    const result = {
        ...catalog,
        ...(overrides.catalog || {}),
        endpoints,
        endpointCount: endpoints.length,
    };
    // Workflows
    if (overrides.workflows?.length) {
        result.workflows = [...(catalog.workflows || []), ...overrides.workflows];
    }
    return { catalog: result, diagnostics };
}
/** Auto-detect the source format from a parsed object. */
export function detectFormat(source) {
    if (!source || typeof source !== "object")
        return "manual";
    const obj = source;
    // OpenAPI 3.x or Swagger 2.x
    if (obj.openapi || obj.swagger || obj.paths)
        return "openapi";
    // GraphQL introspection
    if (obj.__schema || (obj.data && typeof obj.data === "object" && obj.data.__schema)) {
        return "graphql";
    }
    return "manual";
}
// ── TypeScript Source Writer ─────────────────────────────────────────────
/**
 * Generate a TypeScript source file from an ApiCatalog.
 * Produces a complete .ts file with import and export.
 */
export function generateCatalogTypeScript(catalog, options) {
    const json = JSON.stringify(catalog, null, "\t");
    const lines = [
        `/**`,
        ` * ${catalog.name} API Catalog — auto-generated from ${options.sourceLabel || "API spec"}.`,
        ` *`,
        ` * Generated by: npx tsx scripts/generate-catalog.ts`,
        ` * Endpoints: ${catalog.endpointCount}`,
        ` *`,
        ` * To customize: create an overrides JSON/YAML file and re-run the generator.`,
        ` * Hand-edits to enrichment fields (usageHint, example, coveredByTool, workflows)`,
        ` * will be preserved if you use overrides instead of editing this file directly.`,
        ` */`,
        ``,
        `import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";`,
        ``,
        `export const ${options.exportName}: ApiCatalog = ${json};`,
        ``,
    ];
    return lines.join("\n");
}
//# sourceMappingURL=catalog-generator.js.map