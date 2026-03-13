/**
 * Search tool factory — creates a `<prefix>_search` tool for API discovery.
 *
 * Two modes:
 * 1. **Catalog mode** (legacy) — runs in-process keyword search over a static ApiCatalog.
 * 2. **OpenAPI mode** (new) — evaluates agent-written JS with the full resolved
 *    OpenAPI spec available. The agent can search paths, list tags, describe
 *    operations, etc., using injected helper functions.
 *
 * When `openApiSpec` is provided, the tool switches to OpenAPI mode.
 * When only `catalog` is provided, the tool uses the original catalog mode.
 */
import { z } from "zod";
import { buildOpenApiSearchSource } from "./openapi-search";
/**
 * Token-based search over catalog endpoints.
 */
function searchEndpoints(endpoints, query, maxResults) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return [];
    const scored = endpoints.map((ep) => {
        const text = [
            ep.path,
            ep.summary,
            ep.description || "",
            ep.category,
            ep.method,
            ...(ep.pathParams || []).map((p) => `${p.name} ${p.description}`),
            ...(ep.queryParams || []).map((p) => `${p.name} ${p.description}`),
        ]
            .join(" ")
            .toLowerCase();
        let score = 0;
        for (const token of tokens) {
            if (text.includes(token))
                score++;
        }
        return { endpoint: ep, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map((s) => s.endpoint);
}
/**
 * Format an endpoint for display.
 */
function formatEndpoint(ep) {
    const lines = [`${ep.method} ${ep.path} — ${ep.summary}`];
    if (ep.coveredByTool)
        lines.push(`  (also available via tool: ${ep.coveredByTool})`);
    if (ep.pathParams?.length) {
        for (const p of ep.pathParams) {
            lines.push(`  Path: {${p.name}} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}`);
        }
    }
    if (ep.queryParams?.length) {
        for (const p of ep.queryParams) {
            const extras = [];
            if (p.default !== undefined)
                extras.push(`default: ${JSON.stringify(p.default)}`);
            if (p.enum)
                extras.push(`values: ${JSON.stringify(p.enum)}`);
            lines.push(`  Query: ${p.name} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}${extras.length ? ` [${extras.join(", ")}]` : ""}`);
        }
    }
    if (ep.body) {
        lines.push(`  Body: ${ep.body.contentType}${ep.body.description ? ` — ${ep.body.description}` : ""}`);
    }
    return lines.join("\n");
}
/**
 * Count the total number of operations in a resolved OpenAPI spec.
 */
function countSpecOperations(spec) {
    const methods = ["get", "post", "put", "delete", "patch", "options", "head", "trace"];
    let count = 0;
    for (const pathItem of Object.values(spec.paths)) {
        if (!pathItem || typeof pathItem !== "object")
            continue;
        for (const method of methods) {
            if (pathItem[method])
                count++;
        }
    }
    return count;
}
function formatOperation(op) {
    const lines = [`${op.method.toUpperCase()} ${op.path} — ${op.summary || op.operationId || "No summary"}`];
    if (op.operationId)
        lines.push(`  Operation ID: ${op.operationId}`);
    if (op.tags?.length)
        lines.push(`  Tags: ${op.tags.join(", ")}`);
    for (const param of op.parameters || []) {
        const type = param.schema?.type || param.type || "unknown";
        const location = param.in || "unknown";
        lines.push(`  Param: ${param.name || "(unnamed)"} (${location}, ${type}, ${param.required ? "required" : "optional"})` +
            `${param.description ? ` — ${param.description}` : ""}`);
    }
    const contentTypes = Object.keys(op.requestBody?.content || {});
    if (contentTypes.length > 0) {
        lines.push(`  Body: ${contentTypes[0]}${op.requestBody?.description ? ` — ${op.requestBody.description}` : ""}`);
    }
    if (op.responses) {
        for (const [status, response] of Object.entries(op.responses)) {
            if (response?.description) {
                lines.push(`  Response: ${status} — ${response.description}`);
                break;
            }
        }
    }
    return lines.join("\n");
}
/**
 * Build OpenAPI helper functions directly as closures over the parsed spec.
 * Avoids `new Function()` which is blocked by the workerd runtime.
 */
function createOpenApiHelpers(specJson) {
    const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "options", "head", "trace"];
    const spec = Object.freeze(JSON.parse(specJson));
    function collectOperations() {
        const ops = [];
        const paths = spec.paths || {};
        for (const [pathStr, pathItem] of Object.entries(paths)) {
            if (!pathItem || typeof pathItem !== "object")
                continue;
            for (const method of HTTP_METHODS) {
                const op = pathItem[method];
                if (!op || typeof op !== "object")
                    continue;
                ops.push({ path: pathStr, method, ...op });
            }
        }
        return ops;
    }
    function searchPaths(query, maxResults = 10) {
        const ops = collectOperations();
        if (!query || query.trim() === "")
            return ops.slice(0, maxResults);
        const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length === 0)
            return ops.slice(0, maxResults);
        const scored = [];
        for (const op of ops) {
            const textParts = [
                op.path || "", op.method || "", op.summary || "",
                op.description || "", op.operationId || "",
                (op.tags || []).join(" "),
            ];
            if (Array.isArray(op.parameters)) {
                for (const param of op.parameters) {
                    if (param.name)
                        textParts.push(param.name);
                    if (param.description)
                        textParts.push(param.description);
                }
            }
            const text = textParts.join(" ").toLowerCase();
            let score = 0;
            for (const token of tokens) {
                if (text.includes(token))
                    score++;
            }
            if (score > 0)
                scored.push({ op, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, maxResults).map((s) => s.op);
    }
    function listTags() {
        const ops = collectOperations();
        const tagCounts = {};
        for (const op of ops) {
            if (!Array.isArray(op.tags))
                continue;
            for (const tag of op.tags) {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            }
        }
        return Object.entries(tagCounts).map(([tag, count]) => ({ tag, count }));
    }
    function getOperation(idOrPath) {
        const ops = collectOperations();
        for (const op of ops) {
            if (op.operationId === idOrPath)
                return op;
        }
        for (const op of ops) {
            if (op.path === idOrPath)
                return op;
        }
        return null;
    }
    function getOperationByPathAndMethod(path, method) {
        const ops = collectOperations();
        const normalizedMethod = method ? method.toLowerCase() : null;
        for (const op of ops) {
            if (op.path !== path)
                continue;
            if (!normalizedMethod || op.method === normalizedMethod)
                return op;
        }
        return null;
    }
    function describeOp(op, missingLabel) {
        if (!op)
            return missingLabel;
        const lines = [`${op.method.toUpperCase()} ${op.path}`];
        if (op.operationId)
            lines.push(`Operation ID: ${op.operationId}`);
        if (op.summary)
            lines.push(`Summary: ${op.summary}`);
        if (op.description)
            lines.push(`Description: ${op.description}`);
        if (op.tags?.length)
            lines.push(`Tags: ${op.tags.join(", ")}`);
        if (Array.isArray(op.parameters) && op.parameters.length > 0) {
            lines.push("Parameters:");
            for (const p of op.parameters) {
                const paramType = p.schema?.type || p.type || "unknown";
                let line = `  ${p.name || "(unnamed)"} (${p.in || "unknown"}, ${paramType}${p.required ? ", required" : ""})`;
                if (p.description)
                    line += ` — ${p.description}`;
                lines.push(line);
            }
        }
        if (op.responses) {
            const respEntries = Object.entries(op.responses);
            if (respEntries.length > 0) {
                lines.push("Responses:");
                for (const [code, resp] of respEntries) {
                    lines.push(`  ${code}: ${resp?.description || ""}`);
                }
            }
        }
        return lines.join("\n");
    }
    function describeOperation(idOrPath) {
        return describeOp(getOperation(idOrPath), `Operation not found: ${idOrPath}`);
    }
    function describeEndpoint(path, method) {
        const op = getOperationByPathAndMethod(path, method);
        const label = `Endpoint not found: ${(method || "GET").toUpperCase()} ${path}`;
        return describeOp(op, label);
    }
    return {
        searchPaths,
        listTags,
        getOperation,
        describeOperation,
        searchSpec: searchPaths,
        listCategories: () => listTags().map((e) => ({ category: e.tag, count: e.count })),
        getEndpoint: getOperationByPathAndMethod,
        describeEndpoint,
        spec,
        SPEC: spec,
    };
}
function unsupportedExpression() {
    throw new SyntaxError("UNSUPPORTED_EXPRESSION");
}
function readQuotedString(source, start) {
    const quote = source[start];
    let value = "";
    let pos = start + 1;
    let escaped = false;
    while (pos < source.length) {
        const ch = source[pos];
        if (escaped) {
            switch (ch) {
                case "n":
                    value += "\n";
                    break;
                case "r":
                    value += "\r";
                    break;
                case "t":
                    value += "\t";
                    break;
                case "b":
                    value += "\b";
                    break;
                case "f":
                    value += "\f";
                    break;
                case "v":
                    value += "\v";
                    break;
                default:
                    value += ch;
            }
            escaped = false;
            pos++;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            pos++;
            continue;
        }
        if (ch === quote) {
            return {
                value,
                nextPos: pos + 1,
            };
        }
        value += ch;
        pos++;
    }
    return unsupportedExpression();
}
function parseLiteralArg(token) {
    if (token === "true")
        return true;
    if (token === "false")
        return false;
    if (token === "null")
        return null;
    if (token === "undefined")
        return undefined;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
        return Number(token);
    }
    return unsupportedExpression();
}
/** Parse a comma-separated argument string, supporting only literal values. */
function parseArgs(argsStr) {
    const args = [];
    let pos = 0;
    while (pos < argsStr.length) {
        while (pos < argsStr.length && /\s/.test(argsStr[pos]))
            pos++;
        if (pos >= argsStr.length)
            break;
        const ch = argsStr[pos];
        if (ch === '"' || ch === "'") {
            const parsed = readQuotedString(argsStr, pos);
            args.push(parsed.value);
            pos = parsed.nextPos;
        }
        else {
            let end = pos;
            while (end < argsStr.length && argsStr[end] !== ",")
                end++;
            const token = argsStr.slice(pos, end).trim();
            if (!token)
                return unsupportedExpression();
            args.push(parseLiteralArg(token));
            pos = end;
        }
        while (pos < argsStr.length && /\s/.test(argsStr[pos]))
            pos++;
        if (pos >= argsStr.length)
            break;
        if (argsStr[pos] !== ",")
            return unsupportedExpression();
        pos++;
    }
    return args;
}
function parseSpecLookupTokens(expr) {
    let pos = 0;
    if (expr.startsWith("spec")) {
        pos = 4;
    }
    else if (expr.startsWith("SPEC")) {
        pos = 4;
    }
    else {
        return null;
    }
    const tokens = [];
    while (pos < expr.length) {
        while (pos < expr.length && /\s/.test(expr[pos]))
            pos++;
        if (pos >= expr.length)
            break;
        if (expr.startsWith("?.", pos) || expr.startsWith("?.[", pos)) {
            return null;
        }
        if (expr[pos] === ".") {
            pos++;
            const match = expr.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
            if (!match)
                return null;
            tokens.push(match[0]);
            pos += match[0].length;
            continue;
        }
        if (expr[pos] === "[") {
            pos++;
            while (pos < expr.length && /\s/.test(expr[pos]))
                pos++;
            if (expr[pos] !== '"' && expr[pos] !== "'")
                return null;
            const parsed = readQuotedString(expr, pos);
            pos = parsed.nextPos;
            while (pos < expr.length && /\s/.test(expr[pos]))
                pos++;
            if (expr[pos] !== "]")
                return null;
            tokens.push(parsed.value);
            pos++;
            continue;
        }
        return null;
    }
    return tokens;
}
function splitTopLevelExpressions(source) {
    const parts = [];
    let current = "";
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote = null;
    let escaped = false;
    for (let pos = 0; pos < source.length; pos++) {
        const ch = source[pos];
        if (quote) {
            current += ch;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === "(")
            parenDepth++;
        if (ch === ")")
            parenDepth--;
        if (ch === "[")
            bracketDepth++;
        if (ch === "]")
            bracketDepth--;
        if (ch === "{")
            braceDepth++;
        if (ch === "}")
            braceDepth--;
        if (ch === "," &&
            parenDepth === 0 &&
            bracketDepth === 0 &&
            braceDepth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) {
        parts.push(current.trim());
    }
    return parts;
}
function parseCallExpressionAt(expr, start = 0) {
    let pos = start;
    while (pos < expr.length && /\s/.test(expr[pos]))
        pos++;
    const calleeMatch = expr
        .slice(pos)
        .match(/^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)/);
    if (!calleeMatch)
        return null;
    const callee = calleeMatch[1];
    pos += callee.length;
    while (pos < expr.length && /\s/.test(expr[pos]))
        pos++;
    if (expr[pos] !== "(")
        return null;
    const argsStart = pos + 1;
    pos = argsStart;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (; pos < expr.length; pos++) {
        const ch = expr[pos];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "(") {
            depth++;
            continue;
        }
        if (ch === ")") {
            depth--;
            if (depth === 0) {
                return {
                    callee,
                    argsStr: expr.slice(argsStart, pos),
                    nextPos: pos + 1,
                };
            }
        }
    }
    return null;
}
function stripOuterParens(expr) {
    let trimmed = expr.trim();
    while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
        let depth = 0;
        let quote = null;
        let escaped = false;
        let wrapsWhole = true;
        for (let pos = 0; pos < trimmed.length; pos++) {
            const ch = trimmed[pos];
            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === "(")
                depth++;
            if (ch === ")")
                depth--;
            if (depth === 0 && pos < trimmed.length - 1) {
                wrapsWhole = false;
                break;
            }
        }
        if (!wrapsWhole)
            break;
        trimmed = trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function findTopLevelArrow(expr) {
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote = null;
    let escaped = false;
    for (let pos = 0; pos < expr.length - 1; pos++) {
        const ch = expr[pos];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "(")
            parenDepth++;
        if (ch === ")")
            parenDepth--;
        if (ch === "[")
            bracketDepth++;
        if (ch === "]")
            bracketDepth--;
        if (ch === "{")
            braceDepth++;
        if (ch === "}")
            braceDepth--;
        if (expr[pos] === "=" &&
            expr[pos + 1] === ">" &&
            parenDepth === 0 &&
            bracketDepth === 0 &&
            braceDepth === 0) {
            return pos;
        }
    }
    return -1;
}
function findTopLevelOperator(expr, operators) {
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote = null;
    let escaped = false;
    for (let pos = 0; pos < expr.length; pos++) {
        const ch = expr[pos];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "(")
            parenDepth++;
        if (ch === ")")
            parenDepth--;
        if (ch === "[")
            bracketDepth++;
        if (ch === "]")
            bracketDepth--;
        if (ch === "{")
            braceDepth++;
        if (ch === "}")
            braceDepth--;
        if (parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0)
            continue;
        for (const operator of operators) {
            if (expr.startsWith(operator, pos)) {
                return { index: pos, operator };
            }
        }
    }
    return null;
}
function findTopLevelChar(expr, target) {
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote = null;
    let escaped = false;
    for (let pos = 0; pos < expr.length; pos++) {
        const ch = expr[pos];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "(")
            parenDepth++;
        if (ch === ")")
            parenDepth--;
        if (ch === "[")
            bracketDepth++;
        if (ch === "]")
            bracketDepth--;
        if (ch === "{")
            braceDepth++;
        if (ch === "}")
            braceDepth--;
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && ch === target) {
            return pos;
        }
    }
    return -1;
}
function parseMemberAccess(expr) {
    const normalized = stripOuterParens(expr);
    const rootMatch = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (!rootMatch)
        return null;
    const segments = [];
    let pos = rootMatch[0].length;
    while (pos < normalized.length) {
        while (pos < normalized.length && /\s/.test(normalized[pos]))
            pos++;
        if (pos >= normalized.length)
            break;
        if (normalized.startsWith("?.", pos) || normalized.startsWith("?.[", pos)) {
            return null;
        }
        if (normalized[pos] === ".") {
            pos++;
            const match = normalized.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
            if (!match)
                return null;
            segments.push(match[0]);
            pos += match[0].length;
            continue;
        }
        if (normalized[pos] === "[") {
            pos++;
            while (pos < normalized.length && /\s/.test(normalized[pos]))
                pos++;
            if (normalized[pos] === '"' || normalized[pos] === "'") {
                const parsed = readQuotedString(normalized, pos);
                pos = parsed.nextPos;
                while (pos < normalized.length && /\s/.test(normalized[pos]))
                    pos++;
                if (normalized[pos] !== "]")
                    return null;
                segments.push(parsed.value);
                pos++;
                continue;
            }
            const closeIdx = normalized.indexOf("]", pos);
            if (closeIdx === -1)
                return null;
            const token = normalized.slice(pos, closeIdx).trim();
            if (!/^\d+$/.test(token))
                return null;
            segments.push(Number(token));
            pos = closeIdx + 1;
            continue;
        }
        return null;
    }
    return {
        root: rootMatch[1],
        segments,
    };
}
function evaluateMemberAccess(expr, scope) {
    const access = parseMemberAccess(expr);
    if (!access)
        return unsupportedExpression();
    let current = scope[access.root];
    for (const segment of access.segments) {
        if (current == null)
            return undefined;
        current = Reflect.get(Object(current), segment);
    }
    return current;
}
function parseArrowParam(source) {
    const trimmed = source.trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
        return { kind: "identifier", name: trimmed };
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const names = splitTopLevelExpressions(trimmed.slice(1, -1)).map((part) => {
            const token = part.trim();
            return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) ? token : null;
        });
        return { kind: "array", names };
    }
    return unsupportedExpression();
}
function parseArrowFunction(source) {
    const arrowIdx = findTopLevelArrow(source);
    if (arrowIdx === -1)
        return unsupportedExpression();
    let paramsSource = source.slice(0, arrowIdx).trim();
    const body = source.slice(arrowIdx + 2).trim();
    if (!body || body.startsWith("{"))
        return unsupportedExpression();
    if (paramsSource.startsWith("(") && paramsSource.endsWith(")")) {
        paramsSource = paramsSource.slice(1, -1).trim();
    }
    const params = splitTopLevelExpressions(paramsSource).map(parseArrowParam);
    return {
        invoke: (value, index, array) => {
            const scope = {};
            const providedValues = [value, index, array];
            params.forEach((param, paramIndex) => {
                const paramValue = providedValues[paramIndex];
                if (param.kind === "identifier") {
                    scope[param.name] = paramValue;
                }
                else {
                    const entries = Array.isArray(paramValue) ? paramValue : [];
                    param.names.forEach((name, idx) => {
                        if (name) {
                            scope[name] = entries[idx];
                        }
                    });
                }
            });
            if (params.length === 0) {
                scope._ = value;
            }
            return evaluateCallbackExpression(body, scope);
        },
    };
}
function evaluateObjectLiteral(expr, scope) {
    const body = expr.slice(1, -1).trim();
    if (!body)
        return {};
    const result = {};
    for (const field of splitTopLevelExpressions(body)) {
        const colonIdx = findTopLevelChar(field, ":");
        if (colonIdx === -1) {
            const shorthand = field.trim();
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(shorthand)) {
                return unsupportedExpression();
            }
            result[shorthand] = evaluateCallbackExpression(shorthand, scope);
            continue;
        }
        const rawKey = field.slice(0, colonIdx).trim();
        const valueExpr = field.slice(colonIdx + 1).trim();
        let key;
        if (rawKey.startsWith('"') || rawKey.startsWith("'")) {
            key = readQuotedString(rawKey, 0).value;
        }
        else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawKey)) {
            key = rawKey;
        }
        else {
            return unsupportedExpression();
        }
        result[key] = evaluateCallbackExpression(valueExpr, scope);
    }
    return result;
}
function parseOptionalMemberAccess(expr, start) {
    let pos = start;
    let optional = false;
    if (expr.startsWith("?.", pos)) {
        optional = true;
        pos += 2;
    }
    else if (expr.startsWith("?.[", pos)) {
        optional = true;
        pos += 2;
    }
    else if (expr[pos] === ".") {
        pos++;
    }
    else if (expr[pos] !== "[") {
        return null;
    }
    if (expr[pos] === "[") {
        pos++;
        while (pos < expr.length && /\s/.test(expr[pos]))
            pos++;
        let key;
        if (expr[pos] === '"' || expr[pos] === "'") {
            const parsed = readQuotedString(expr, pos);
            key = parsed.value;
            pos = parsed.nextPos;
        }
        else {
            const closeIdx = expr.indexOf("]", pos);
            if (closeIdx === -1)
                return null;
            const token = expr.slice(pos, closeIdx).trim();
            if (!/^\d+$/.test(token))
                return null;
            key = Number(token);
            pos = closeIdx;
        }
        while (pos < expr.length && /\s/.test(expr[pos]))
            pos++;
        if (expr[pos] !== "]")
            return null;
        return {
            key,
            nextPos: pos + 1,
            optional,
        };
    }
    const identifier = expr.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!identifier)
        return null;
    return {
        key: identifier[0],
        nextPos: pos + identifier[0].length,
        optional,
    };
}
function applyOptionalMemberAccess(value, expr, start) {
    const parsed = parseOptionalMemberAccess(expr, start);
    if (!parsed)
        return null;
    if (value == null) {
        if (parsed.optional) {
            return {
                value: undefined,
                nextPos: parsed.nextPos,
            };
        }
        return unsupportedExpression();
    }
    return {
        value: Reflect.get(Object(value), parsed.key),
        nextPos: parsed.nextPos,
    };
}
function evaluateCallbackExpression(source, scope) {
    const expr = stripOuterParens(source);
    if (!expr)
        return undefined;
    if (expr.startsWith("{") && expr.endsWith("}")) {
        return evaluateObjectLiteral(expr, scope);
    }
    const nullish = findTopLevelOperator(expr, ["??"]);
    if (nullish) {
        const left = evaluateCallbackExpression(expr.slice(0, nullish.index), scope);
        return left ?? evaluateCallbackExpression(expr.slice(nullish.index + 2), scope);
    }
    const logicalOr = findTopLevelOperator(expr, ["||"]);
    if (logicalOr) {
        return (evaluateCallbackExpression(expr.slice(0, logicalOr.index), scope) ||
            evaluateCallbackExpression(expr.slice(logicalOr.index + 2), scope));
    }
    const logicalAnd = findTopLevelOperator(expr, ["&&"]);
    if (logicalAnd) {
        return (evaluateCallbackExpression(expr.slice(0, logicalAnd.index), scope) &&
            evaluateCallbackExpression(expr.slice(logicalAnd.index + 2), scope));
    }
    const comparison = findTopLevelOperator(expr, ["===", "!==", "==", "!="]);
    if (comparison) {
        const left = evaluateCallbackExpression(expr.slice(0, comparison.index), scope);
        const right = evaluateCallbackExpression(expr.slice(comparison.index + comparison.operator.length), scope);
        switch (comparison.operator) {
            case "===":
                return left === right;
            case "!==":
                return left !== right;
            case "==":
                return left == right;
            case "!=":
                return left != right;
            default:
                return unsupportedExpression();
        }
    }
    const call = parseCallExpressionAt(expr);
    if (call && call.nextPos === expr.length) {
        const lastDot = call.callee.lastIndexOf(".");
        if (lastDot === -1) {
            return unsupportedExpression();
        }
        const receiver = evaluateCallbackExpression(call.callee.slice(0, lastDot), scope);
        const method = call.callee.slice(lastDot + 1);
        const args = splitTopLevelExpressions(call.argsStr).map((part) => evaluateCallbackExpression(part, scope));
        if (method === "includes" && receiver != null) {
            return receiver.includes(...args);
        }
        if (method === "startsWith" && typeof receiver === "string") {
            return receiver.startsWith(String(args[0] ?? ""));
        }
        if (method === "endsWith" && typeof receiver === "string") {
            return receiver.endsWith(String(args[0] ?? ""));
        }
        return unsupportedExpression();
    }
    if (expr[0] === '"' || expr[0] === "'") {
        return readQuotedString(expr, 0).value;
    }
    if (expr === "true")
        return true;
    if (expr === "false")
        return false;
    if (expr === "null")
        return null;
    if (expr === "undefined")
        return undefined;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(expr)) {
        return Number(expr);
    }
    return evaluateMemberAccess(expr, scope);
}
function evaluateArrayMethod(value, method, argsStr) {
    if (method === "length") {
        return Array.isArray(value) || typeof value === "string"
            ? value.length
            : unsupportedExpression();
    }
    if (method === "map" || method === "filter" || method === "find") {
        if (!Array.isArray(value))
            return unsupportedExpression();
        const callback = parseArrowFunction(argsStr);
        if (method === "map") {
            return value.map((entry, index, array) => callback.invoke(entry, index, array));
        }
        if (method === "filter") {
            return value.filter((entry, index, array) => Boolean(callback.invoke(entry, index, array)));
        }
        return value.find((entry, index, array) => Boolean(callback.invoke(entry, index, array)));
    }
    if (method === "slice") {
        if (!Array.isArray(value) && typeof value !== "string") {
            return unsupportedExpression();
        }
        const args = argsStr.trim() ? parseArgs(argsStr) : [];
        return value.slice(typeof args[0] === "number" ? args[0] : undefined, typeof args[1] === "number" ? args[1] : undefined);
    }
    return unsupportedExpression();
}
function evaluateSafeExpression(expr, helpers) {
    const normalized = stripOuterParens(expr);
    const helperFns = {
        searchPaths: (q, m) => helpers.searchPaths(String(q ?? ""), Number(m) || 10),
        searchSpec: (q, m) => helpers.searchSpec(String(q ?? ""), Number(m) || 10),
        listTags: () => helpers.listTags(),
        listCategories: () => helpers.listCategories(),
        getOperation: (id) => helpers.getOperation(String(id ?? "")),
        getEndpoint: (p, m) => helpers.getEndpoint(String(p ?? ""), m ? String(m) : undefined),
        describeOperation: (id) => helpers.describeOperation(String(id ?? "")),
        describeEndpoint: (p, m) => helpers.describeEndpoint(String(p ?? ""), m ? String(m) : undefined),
    };
    const baseCall = parseCallExpressionAt(normalized);
    let current;
    let pos = 0;
    if (baseCall) {
        if (helperFns[baseCall.callee]) {
            const args = baseCall.argsStr.trim() ? parseArgs(baseCall.argsStr) : [];
            current = helperFns[baseCall.callee](...args);
            pos = baseCall.nextPos;
        }
        else if (baseCall.callee === "Object.entries" ||
            baseCall.callee === "Object.keys" ||
            baseCall.callee === "Object.values") {
            const args = splitTopLevelExpressions(baseCall.argsStr);
            if (args.length !== 1)
                return unsupportedExpression();
            const target = evaluateSafeExpression(args[0], helpers);
            if (target == null || typeof target !== "object") {
                return unsupportedExpression();
            }
            if (baseCall.callee === "Object.entries") {
                current = Object.entries(target);
            }
            else if (baseCall.callee === "Object.keys") {
                current = Object.keys(target);
            }
            else {
                current = Object.values(target);
            }
            pos = baseCall.nextPos;
        }
        else {
            return unsupportedExpression();
        }
    }
    else {
        const lookupTokens = parseSpecLookupTokens(normalized);
        if (!lookupTokens)
            return unsupportedExpression();
        current = helpers.spec;
        for (let i = 0; i < lookupTokens.length; i++) {
            if (current == null) {
                return unsupportedExpression();
            }
            const next = Reflect.get(Object(current), lookupTokens[i]);
            if (next === undefined && i < lookupTokens.length - 1) {
                return unsupportedExpression();
            }
            current = next;
        }
        pos = normalized.length;
    }
    while (pos < normalized.length) {
        while (pos < normalized.length && /\s/.test(normalized[pos]))
            pos++;
        if (pos >= normalized.length)
            break;
        if (normalized[pos] === "." ||
            normalized[pos] === "[" ||
            normalized.startsWith("?.", pos) ||
            normalized.startsWith("?.[", pos)) {
            const optionalAccess = applyOptionalMemberAccess(current, normalized, pos);
            if (optionalAccess &&
                (optionalAccess.nextPos >= normalized.length || normalized[optionalAccess.nextPos] !== "(")) {
                current = optionalAccess.value;
                pos = optionalAccess.nextPos;
                continue;
            }
            if (normalized[pos] !== "." && !normalized.startsWith("?.", pos)) {
                return unsupportedExpression();
            }
            pos++;
            const identifier = normalized
                .slice(pos)
                .match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
            if (!identifier)
                return unsupportedExpression();
            const methodOrProperty = identifier[0];
            pos += methodOrProperty.length;
            while (pos < normalized.length && /\s/.test(normalized[pos]))
                pos++;
            if (normalized[pos] === "(") {
                const call = parseCallExpressionAt(normalized, pos - methodOrProperty.length);
                if (!call || call.callee !== methodOrProperty) {
                    return unsupportedExpression();
                }
                current = evaluateArrayMethod(current, methodOrProperty, call.argsStr);
                pos = call.nextPos;
                continue;
            }
            if (current == null)
                return unsupportedExpression();
            current = Reflect.get(Object(current), methodOrProperty);
            continue;
        }
        return unsupportedExpression();
    }
    return current;
}
/**
 * Interpret common search helper calls without using new Function().
 * Supports patterns like: `return searchPaths("query")`, `searchPaths("query")`,
 * `return listTags()`, `return describeOperation("id")`, etc.
 *
 * Returns the result on success, or throws if the expression is not
 * a pattern this mini-interpreter can handle (caller should fall back
 * to new Function()).
 */
function interpretSearchCode(code, helpers) {
    // Strip optional "return " prefix so multiline calls like
    // `searchPaths(\n  "studies",\n  5\n)` still parse cleanly.
    const expr = code.replace(/^return\s+/, "").replace(/;$/, "").trim();
    if (!expr) {
        return unsupportedExpression();
    }
    return evaluateSafeExpression(expr, helpers);
}
/**
 * Execute search code against OpenAPI helpers.
 * Tries the safe interpreter first; falls back to new Function() for
 * arbitrary JavaScript (e.g. `.map()`, `.filter()`, `Object.entries()`).
 */
function executeSearchCode(code, helpers, specJson) {
    try {
        return interpretSearchCode(code, helpers);
    }
    catch (err) {
        if (err instanceof SyntaxError && err.message === "UNSUPPORTED_EXPRESSION") {
            // Fall back to new Function() with the full search helpers injected.
            // This works in Node.js and may work in some Workers runtimes;
            // if blocked, the error propagates naturally.
            const searchSource = buildOpenApiSearchSource(specJson);
            const wrappedCode = `${searchSource}\n${code}`;
            const fn = new Function(wrappedCode);
            return fn();
        }
        throw err;
    }
}
/**
 * Create a search tool in OpenAPI mode.
 *
 * The tool accepts a `code` parameter — agent-written JavaScript that runs
 * with the full resolved OpenAPI spec and helper functions (searchPaths,
 * listTags, getOperation, describeOperation) available.
 */
function createOpenApiSearchTool(prefix, spec) {
    const toolName = `${prefix}_search`;
    const operationCount = countSpecOperations(spec);
    const specJson = JSON.stringify(spec);
    const helpers = createOpenApiHelpers(specJson);
    return {
        name: toolName,
        description: `Search the ${spec.info.title} API (${operationCount} operations across ${Object.keys(spec.paths).length} paths). ` +
            `Write JavaScript code to search the OpenAPI spec, or use the legacy query/category arguments for keyword search. Available functions:\n\n` +
            `- searchPaths(query, maxResults=10) — keyword search across paths, summaries, tags, parameters\n` +
            `- listTags() — list all tags with operation counts\n` +
            `- getOperation(idOrPath) — get full operation by operationId or path\n` +
            `- describeOperation(idOrPath) — formatted documentation for an operation\n` +
            `- searchSpec/query helpers are also available for backward compatibility inside execute()\n` +
            `- spec — the full frozen OpenAPI spec object (spec.paths, spec.info, etc.)\n\n` +
            `Use ${prefix}_search to discover endpoints, then write code in ${prefix}_execute to call them.\n\n` +
            `USAGE IN ${prefix}_execute:\n` +
            `- api.get(path, params) for GET, api.post(path, body, params) for POST\n` +
            `- Path params like /lookup/{id} are auto-interpolated from params\n` +
            `- Large responses (>100KB) are auto-staged; use ${prefix}_query_data to explore`,
        schema: {
            code: z.string().describe("JavaScript code to search the API spec. Use searchPaths(), listTags(), " +
                "getOperation(), describeOperation(), or access spec.paths directly. " +
                'Examples: \'return searchPaths("studies")\', \'return listTags()\', ' +
                '\'return describeOperation("getStudies")\''),
            query: z.string().optional().describe("Legacy keyword search. Optional alternative to code. Use '*' or an empty string to browse operations."),
            category: z.string().optional().describe("Legacy category filter. Matches OpenAPI tags case-insensitively."),
            max_results: z.number().optional().describe("Maximum results to return for legacy keyword search (default 10, max 25)."),
        },
        register(server) {
            const description = this.description;
            const schema = this.schema;
            server.tool(toolName, description, schema, async (input) => {
                const code = input.code?.trim() || "";
                const query = input.query?.trim() || "";
                const category = input.category?.trim();
                const maxResults = Math.min(input.max_results || 10, 25);
                if (!code) {
                    let results = query === "*" || query === ""
                        ? helpers.searchPaths("", operationCount)
                        : helpers.searchPaths(query, category ? operationCount : maxResults);
                    if (category) {
                        const normalized = category.toLowerCase();
                        results = results.filter((op) => (op.tags || []).some((tag) => tag.toLowerCase() === normalized));
                    }
                    if (query === "*" || query === "") {
                        results = results.slice(0, maxResults);
                    }
                    if (results.length === 0) {
                        const availableTags = helpers.listTags()
                            .map((entry) => `  ${entry.tag} (${entry.count} operations)`)
                            .join("\n");
                        return {
                            content: [{
                                    type: "text",
                                    text: `No operations found for "${query || "*"}"${category ? ` in category "${category}"` : ""}.\n\n` +
                                        `Available categories:\n${availableTags}\n\nTry broader search terms, browse by category, or provide code.`,
                                }],
                            structuredContent: {
                                success: true,
                                data: {
                                    total_operations: operationCount,
                                    total_endpoints: operationCount,
                                    results_count: 0,
                                    operations: [],
                                    endpoints: [],
                                },
                            },
                        };
                    }
                    const formatted = results.map(formatOperation).join("\n\n");
                    const header = `Found ${results.length} operation(s) in ${spec.info.title} API (${operationCount} total):`;
                    return {
                        content: [{ type: "text", text: `${header}\n\n${formatted}` }],
                        structuredContent: {
                            success: true,
                            data: {
                                total_operations: operationCount,
                                total_endpoints: operationCount,
                                results_count: results.length,
                                operations: results,
                                endpoints: results,
                            },
                        },
                    };
                }
                try {
                    // Try safe interpreter first, fall back to new Function()
                    // for complex JS (map/filter chains, Object.entries, etc.).
                    const result = executeSearchCode(code, helpers, specJson);
                    let textOutput;
                    if (typeof result === "string") {
                        textOutput = result;
                    }
                    else {
                        textOutput = JSON.stringify(result, null, 2) ?? String(result);
                    }
                    return {
                        content: [{ type: "text", text: textOutput }],
                        structuredContent: {
                            success: true,
                            data: result,
                        },
                    };
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        content: [{
                                type: "text",
                                text: `Search code error: ${message}`,
                            }],
                        structuredContent: {
                            success: false,
                            error: { code: "SEARCH_ERROR", message },
                        },
                        isError: true,
                    };
                }
            });
        },
    };
}
/**
 * Create a search tool in catalog mode (legacy).
 *
 * The tool accepts query/category/max_results parameters and performs
 * keyword-based search over the static ApiCatalog.
 */
function createCatalogSearchTool(prefix, catalog) {
    const toolName = `${prefix}_search`;
    // Collect categories for the description
    const categories = new Map();
    for (const ep of catalog.endpoints) {
        categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
    }
    const categoryList = Array.from(categories.entries())
        .map(([cat, count]) => `${cat} (${count})`)
        .join(", ");
    const notesSection = catalog.notes ? `\n\nNOTES:\n${catalog.notes}` : "";
    return {
        name: toolName,
        description: `Search the ${catalog.name} API catalog (${catalog.endpointCount} endpoints). ` +
            `Returns matching endpoints with full parameter docs. Use this to discover API capabilities before calling ${prefix}_execute.\n\n` +
            `Categories: ${categoryList}\n\n` +
            `USAGE IN ${prefix}_execute:\n` +
            `- api.get(path, params) for GET, api.post(path, body, params) for POST\n` +
            `- Path params like /lookup/{id} are auto-interpolated from params: api.get('/lookup/{id}', {id: 'ENSG...'})\n` +
            `- Remaining params become query string\n` +
            `- Large responses (>100KB) are auto-staged: check result.__staged, return the staging info, use ${prefix}_query_data to explore\n` +
            `- Use limit/pagination params to control response size. Large datasets auto-stage for SQL queries.` +
            notesSection,
        schema: {
            query: z.string().describe("Search query — keywords matching endpoint paths, descriptions, parameters, or categories. Examples: 'gene expression', 'variant annotation', 'tissue'"),
            category: z.string().optional().describe("Filter to a specific category. Use query='*' with a category to list all endpoints in that category."),
            max_results: z.number().optional().describe("Maximum results to return (default 10, max 25)"),
        },
        register(server) {
            server.tool(toolName, this.description, this.schema, async (input) => {
                const maxResults = Math.min(input.max_results || 10, 25);
                const query = input.query?.trim() || "";
                let endpoints = catalog.endpoints;
                // Filter by category if specified
                if (input.category) {
                    endpoints = endpoints.filter((ep) => ep.category.toLowerCase() === input.category.toLowerCase());
                }
                let results;
                if (query === "*" || query === "") {
                    // List mode — return all (within category filter)
                    results = endpoints.slice(0, maxResults);
                }
                else {
                    results = searchEndpoints(endpoints, query, maxResults);
                }
                if (results.length === 0) {
                    // Return available categories as a hint
                    const categories = new Map();
                    for (const ep of catalog.endpoints) {
                        categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
                    }
                    const catList = Array.from(categories.entries())
                        .map(([cat, count]) => `  ${cat} (${count} endpoints)`)
                        .join("\n");
                    return {
                        content: [{
                                type: "text",
                                text: `No endpoints found for "${query}"${input.category ? ` in category "${input.category}"` : ""}.\n\nAvailable categories:\n${catList}\n\nTry broader search terms or browse by category.`,
                            }],
                    };
                }
                const formatted = results.map(formatEndpoint).join("\n\n");
                const header = `Found ${results.length} endpoint(s) in ${catalog.name} API (${catalog.endpointCount} total):`;
                return {
                    content: [{ type: "text", text: `${header}\n\n${formatted}` }],
                    structuredContent: {
                        success: true,
                        data: {
                            total_endpoints: catalog.endpointCount,
                            results_count: results.length,
                            endpoints: results,
                        },
                    },
                };
            });
        },
    };
}
/**
 * Create a search tool registration object.
 * Returns { name, description, schema, register } for the server to use.
 *
 * When `openApiSpec` is provided, creates a code-execution search tool.
 * When only `catalog` is provided, creates a keyword search tool (legacy).
 */
export function createSearchTool(options) {
    const { prefix, catalog, openApiSpec } = options;
    if (openApiSpec) {
        return createOpenApiSearchTool(prefix, openApiSpec);
    }
    if (catalog) {
        return createCatalogSearchTool(prefix, catalog);
    }
    throw new Error("createSearchTool requires either 'catalog' or 'openApiSpec'");
}
//# sourceMappingURL=search-tool.js.map