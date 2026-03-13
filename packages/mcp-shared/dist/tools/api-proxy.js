/**
 * Hidden __api_proxy tool — routes V8 isolate api.get/api.post calls
 * through the server's HTTP fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It validates paths, delegates to the server's ApiFetchFn, and
 * auto-stages large responses via stageToDoAndRespond().
 */
import { z } from "zod";
import { shouldStage, stageToDoAndRespond, queryDataFromDo } from "../staging/utils";
/** Path traversal patterns to reject */
const DANGEROUS_PATTERNS = [
    /\.\.\//, // Directory traversal
    /\/\.\./, // Reverse traversal
    /%2e%2e/i, // URL-encoded traversal
    /\/\//, // Double slash
];
function validatePath(path) {
    if (!path.startsWith("/")) {
        throw new Error(`Path must start with /: ${path}`);
    }
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(path)) {
            throw new Error(`Dangerous path pattern detected: ${path}`);
        }
    }
}
/**
 * Interpolate path parameters: /lookup/id/{id} with {id: "ENSG..."} => /lookup/id/ENSG...
 * Returns the interpolated path and remaining (non-path) params.
 */
function interpolatePath(path, params) {
    const queryParams = { ...params };
    const interpolated = path.replace(/\{(\w+)\}/g, (_match, key) => {
        const value = queryParams[key];
        if (value === undefined || value === null) {
            throw new Error(`Missing required path parameter: ${key}`);
        }
        delete queryParams[key];
        return encodeURIComponent(String(value));
    });
    return { path: interpolated, queryParams };
}
/** Max size (bytes) for a single property to be preserved in the staging envelope. */
const ENVELOPE_SCALAR_LIMIT = 1024;
/**
 * Copy small scalar properties from the original API response onto the
 * staging metadata object. This preserves values like `.count`, `.total`,
 * `.schema`, `.paging_info` so LLM code can read them without an extra
 * round-trip (ADR-004 Option C).
 */
function preserveEnvelopeScalars(original, staging) {
    if (!original || typeof original !== "object" || Array.isArray(original)) {
        return;
    }
    for (const [key, value] of Object.entries(original)) {
        if (key in staging)
            continue; // don't clobber staging metadata fields
        try {
            const serialized = JSON.stringify(value);
            if (serialized !== undefined && serialized.length <= ENVELOPE_SCALAR_LIMIT) {
                staging[key] = value;
            }
        }
        catch {
            // Skip non-serializable values
        }
    }
}
const HTTP_METHODS = new Set([
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "trace",
]);
function uniqueStrings(values) {
    return Array.from(new Set(values.filter((value) => Boolean(value))));
}
function extractCatalogEndpoints(catalog) {
    if (!catalog)
        return [];
    return catalog.endpoints.map((endpoint) => ({
        method: endpoint.method.toUpperCase(),
        path: endpoint.path,
        summary: endpoint.summary,
        pathParamNames: (endpoint.pathParams || []).map((param) => param.name),
        queryParamNames: (endpoint.queryParams || []).map((param) => param.name),
    }));
}
function extractSpecParamNames(params, location) {
    if (!Array.isArray(params))
        return [];
    return uniqueStrings(params.flatMap((param) => {
        if (!param || typeof param !== "object")
            return [];
        const record = param;
        if (record.in !== location || typeof record.name !== "string")
            return [];
        return [record.name];
    }));
}
function extractSpecEndpoints(spec) {
    if (!spec)
        return [];
    const endpoints = [];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
        if (!pathItem || typeof pathItem !== "object")
            continue;
        const pathRecord = pathItem;
        const pathParams = Array.isArray(pathRecord.parameters) ? pathRecord.parameters : [];
        for (const [method, operation] of Object.entries(pathRecord)) {
            if (!HTTP_METHODS.has(method) || !operation || typeof operation !== "object") {
                continue;
            }
            const operationRecord = operation;
            const operationParams = Array.isArray(operationRecord.parameters)
                ? operationRecord.parameters
                : [];
            const mergedParams = [...pathParams, ...operationParams];
            endpoints.push({
                method: method.toUpperCase(),
                path,
                summary: typeof operationRecord.summary === "string"
                    ? operationRecord.summary
                    : typeof operationRecord.operationId === "string"
                        ? operationRecord.operationId
                        : undefined,
                pathParamNames: extractSpecParamNames(mergedParams, "path"),
                queryParamNames: extractSpecParamNames(mergedParams, "query"),
            });
        }
    }
    return endpoints;
}
function buildKnownEndpointIndex(catalog, openApiSpec) {
    const merged = new Map();
    for (const endpoint of [...extractCatalogEndpoints(catalog), ...extractSpecEndpoints(openApiSpec)]) {
        const key = `${endpoint.method} ${endpoint.path}`;
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, {
                ...endpoint,
                pathParamNames: uniqueStrings(endpoint.pathParamNames),
                queryParamNames: uniqueStrings(endpoint.queryParamNames),
            });
            continue;
        }
        existing.summary ||= endpoint.summary;
        existing.pathParamNames = uniqueStrings([
            ...existing.pathParamNames,
            ...endpoint.pathParamNames,
        ]);
        existing.queryParamNames = uniqueStrings([
            ...existing.queryParamNames,
            ...endpoint.queryParamNames,
        ]);
    }
    return Array.from(merged.values());
}
function pathTemplateToRegExp(pathTemplate) {
    const escaped = pathTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`);
}
function pathMatches(requestPath, endpointPath) {
    return requestPath === endpointPath || pathTemplateToRegExp(endpointPath).test(requestPath);
}
function pathSegments(path) {
    return path
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase())
        .map((segment) => (segment.startsWith("{") && segment.endsWith("}") ? "{}" : segment));
}
function scoreSuggestion(requestPath, method, endpoint) {
    const requestSegments = pathSegments(requestPath);
    const endpointSegments = pathSegments(endpoint.path);
    let score = endpoint.method === method ? 10 : 0;
    const sharedPrefix = Math.min(requestSegments.length, endpointSegments.length);
    for (let i = 0; i < sharedPrefix; i++) {
        if (requestSegments[i] === endpointSegments[i]) {
            score += 4;
        }
        else if (requestSegments[i] === "{}" || endpointSegments[i] === "{}") {
            score += 2;
        }
        else {
            break;
        }
    }
    const overlap = requestSegments.filter((segment) => endpointSegments.includes(segment)).length;
    score += overlap;
    score -= Math.abs(requestSegments.length - endpointSegments.length);
    if (endpoint.path.includes("{") && pathMatches(requestPath, endpoint.path)) {
        score += 8;
    }
    return score;
}
function buildSuggestions(requestPath, method, knownEndpoints) {
    return knownEndpoints
        .map((endpoint) => ({
        endpoint,
        score: scoreSuggestion(requestPath, method, endpoint),
    }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .map(({ endpoint }) => ({
        method: endpoint.method,
        path: endpoint.path,
        ...(endpoint.summary ? { summary: endpoint.summary } : {}),
    }));
}
function buildDriftHint(method, requestPath, status, knownEndpoints) {
    if (knownEndpoints.length === 0)
        return undefined;
    const normalizedMethod = method.toUpperCase();
    const exactMatches = knownEndpoints.filter((endpoint) => endpoint.method === normalizedMethod && pathMatches(requestPath, endpoint.path));
    const pathMatchesAnyMethod = knownEndpoints.filter((endpoint) => pathMatches(requestPath, endpoint.path));
    if (exactMatches.length === 0) {
        const knownMethods = uniqueStrings(pathMatchesAnyMethod.map((endpoint) => endpoint.method));
        const suggestions = buildSuggestions(requestPath, normalizedMethod, knownEndpoints);
        const suggestionText = suggestions.length > 0
            ? ` Closest known endpoints: ${suggestions
                .map((suggestion) => `${suggestion.method} ${suggestion.path}`)
                .join(", ")}.`
            : "";
        const methodText = knownMethods.length > 0
            ? ` Known methods for this path in current metadata: ${knownMethods.join(", ")}.`
            : "";
        return {
            kind: "unknown_endpoint",
            message: `This call does not match the current search metadata for ${normalizedMethod} ${requestPath}.` +
                methodText +
                ` Re-run searchSpec()/getEndpoint() before retrying.` +
                suggestionText,
            ...(suggestions.length > 0 ? { suggestions } : {}),
            ...(knownMethods.length > 0 ? { known_methods: knownMethods } : {}),
        };
    }
    const matchedEndpoint = exactMatches[0];
    const expectedParams = uniqueStrings([
        ...matchedEndpoint.pathParamNames,
        ...matchedEndpoint.queryParamNames,
    ]);
    if ([400, 422].includes(status) && expectedParams.length > 0) {
        return {
            kind: "parameter_mismatch",
            message: `${normalizedMethod} ${matchedEndpoint.path} matches current metadata, but the API returned ${status}. ` +
                `Expected path/query params include: ${expectedParams.join(", ")}. ` +
                `Re-run getEndpoint(${JSON.stringify(matchedEndpoint.path)}, ${JSON.stringify(normalizedMethod)}) ` +
                `or describeEndpoint(...) to verify names and required fields.`,
            expected_params: expectedParams,
        };
    }
    if ([404, 405, 410, 501].includes(status)) {
        const knownMethods = uniqueStrings(pathMatchesAnyMethod.map((endpoint) => endpoint.method));
        return {
            kind: "contract_changed",
            message: `${normalizedMethod} ${matchedEndpoint.path} exists in current search metadata, but the upstream API returned ${status}. ` +
                `This usually means the provider removed or renamed the endpoint, changed the allowed method, or the committed search metadata is stale. ` +
                `Re-run searchSpec()/getEndpoint() and compare against the live docs or spec before retrying.` +
                (knownMethods.length > 0 ? ` Known methods for this path: ${knownMethods.join(", ")}.` : ""),
            ...(knownMethods.length > 0 ? { known_methods: knownMethods } : {}),
        };
    }
    return undefined;
}
/**
 * Create the hidden __api_proxy tool entry.
 */
export function createApiProxyTool(options) {
    const { apiFetch, catalog, openApiSpec, doNamespace, stagingPrefix, stagingThreshold, } = options;
    const knownEndpoints = buildKnownEndpointIndex(catalog, openApiSpec);
    return {
        name: "__api_proxy",
        description: "Route API calls from V8 isolate through server HTTP layer. Internal only.",
        hidden: true,
        schema: {
            method: z.enum(["GET", "POST", "PUT", "DELETE"]),
            path: z.string(),
            params: z.record(z.string(), z.unknown()).optional(),
            body: z.unknown().optional(),
        },
        handler: async (input) => {
            const method = String(input.method || "GET");
            const rawPath = String(input.path || "/");
            const rawParams = input.params ?? {};
            const body = input.body;
            let interpolatedPath = rawPath;
            try {
                validatePath(rawPath);
                // Interpolate path params and extract remaining as query params
                const { path, queryParams } = interpolatePath(rawPath, rawParams);
                interpolatedPath = path;
                const result = await apiFetch({
                    method,
                    path,
                    params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
                    body,
                });
                // Check if response should be auto-staged
                const responseBytes = JSON.stringify(result.data).length;
                if (doNamespace &&
                    stagingPrefix &&
                    shouldStage(responseBytes, stagingThreshold)) {
                    const staged = await stageToDoAndRespond(result.data, doNamespace, stagingPrefix, undefined, undefined, stagingPrefix);
                    const response = {
                        __staged: true,
                        data_access_id: staged.dataAccessId,
                        schema: staged.schema,
                        tables_created: staged.tablesCreated,
                        total_rows: staged.totalRows,
                        _staging: staged._staging,
                        message: `Response auto-staged (${(responseBytes / 1024).toFixed(1)}KB). Use query() or the query_data tool with data_access_id="${staged.dataAccessId}" to explore the data.`,
                    };
                    preserveEnvelopeScalars(result.data, response);
                    return response;
                }
                return result.data;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const status = err.status || 500;
                const driftHint = buildDriftHint(method, interpolatedPath, status, knownEndpoints);
                return {
                    __api_error: true,
                    status,
                    message,
                    data: err.data,
                    ...(driftHint ? { drift_hint: driftHint } : {}),
                };
            }
        },
    };
}
/**
 * Create the hidden __query_proxy tool entry.
 * Routes SQL queries from isolate api.query()/db.queryStaged() to the
 * Durable Object's /query endpoint via queryDataFromDo().
 */
export function createQueryProxyTool(options) {
    const { doNamespace } = options;
    return {
        name: "__query_proxy",
        description: "Route SQL queries from V8 isolate to staged data DO. Internal only.",
        hidden: true,
        schema: {
            data_access_id: z.string(),
            sql: z.string(),
        },
        handler: async (input) => {
            const dataAccessId = String(input.data_access_id || "");
            const sql = String(input.sql || "");
            if (!dataAccessId) {
                return { __query_error: true, message: "data_access_id is required" };
            }
            if (!sql) {
                return { __query_error: true, message: "sql is required" };
            }
            try {
                const result = await queryDataFromDo(doNamespace, dataAccessId, sql, 1000);
                return {
                    rows: result.rows,
                    row_count: result.row_count,
                    sql: result.sql,
                    data_access_id: result.data_access_id,
                };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { __query_error: true, message };
            }
        },
    };
}
//# sourceMappingURL=api-proxy.js.map