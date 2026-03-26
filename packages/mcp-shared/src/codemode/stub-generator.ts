/**
 * Stub generator — auto-generates code examples and quick references from
 * API catalog endpoints and OpenAPI operations.
 *
 * These stubs are surfaced in _search results and _execute tool descriptions
 * so the LLM can write more accurate api.get()/api.post() calls.
 */

import type { ApiCatalog, ApiEndpoint, ParamDef } from "./catalog";

interface OpenApiParameter {
	name?: string;
	in?: string;
	required?: boolean;
	description?: string;
	schema?: { type?: string; default?: unknown; example?: unknown; enum?: unknown[] };
	type?: string;
	example?: unknown;
}

interface OpenApiOperation {
	path: string;
	method: string;
	summary?: string;
	description?: string;
	operationId?: string;
	tags?: string[];
	parameters?: OpenApiParameter[];
	requestBody?: {
		description?: string;
		required?: boolean;
		content?: Record<string, { schema?: { type?: string; properties?: Record<string, unknown> } }>;
	};
}

/**
 * Extract a placeholder value from a ParamDef based on its description, default, or type.
 */
function placeholderFromParam(p: ParamDef): string {
	if (p.default !== undefined && p.default !== null) {
		return JSON.stringify(p.default);
	}
	if (p.enum && p.enum.length > 0) {
		return JSON.stringify(p.enum[0]);
	}
	// Extract example values from description (e.g., "e.g. ENSG00000157764", "(e.g., Brain_Cortex)")
	const egMatch = p.description.match(/(?:e\.g\.?,?\s*|for example,?\s*)["']?([^"'\s,)]+)/i);
	if (egMatch) return JSON.stringify(egMatch[1]);

	// Type-based fallback
	switch (p.type) {
		case "number": return "1";
		case "boolean": return "true";
		case "array": return '["value"]';
		default: return `"${p.name}_value"`;
	}
}

/**
 * Extract a placeholder value from an OpenAPI parameter.
 */
function placeholderFromOpenApiParam(p: OpenApiParameter): string {
	if (p.example !== undefined) return JSON.stringify(p.example);
	if (p.schema?.example !== undefined) return JSON.stringify(p.schema?.example);
	if (p.schema?.default !== undefined) return JSON.stringify(p.schema?.default);
	if (p.schema?.enum && p.schema?.enum.length > 0) return JSON.stringify(p.schema?.enum[0]);

	const desc = p.description || "";
	const egMatch = desc.match(/(?:e\.g\.?,?\s*|for example,?\s*)["']?([^"'\s,)]+)/i);
	if (egMatch) return JSON.stringify(egMatch[1]);

	const type = p.schema?.type || p.type || "string";
	switch (type) {
		case "integer":
		case "number": return "1";
		case "boolean": return "true";
		case "array": return '["value"]';
		default: return `"${p.name || "value"}"`;
	}
}

/**
 * Generate a code example for an ApiEndpoint.
 * Returns the manual `ep.example` if set, otherwise auto-generates from params.
 */
export function generateEndpointStub(ep: ApiEndpoint): string {
	if (ep.example) return ep.example;

	const method = ep.method === "GET" ? "api.get" : "api.post";
	const paramLines: string[] = [];

	// Path params
	for (const p of ep.pathParams || []) {
		const comment = p.required ? "required" : "optional";
		paramLines.push(`  ${p.name}: ${placeholderFromParam(p)},  // ${comment}, ${p.type}`);
	}

	// Query params (required first, then optional with defaults)
	const requiredQuery = (ep.queryParams || []).filter(p => p.required);
	const optionalQuery = (ep.queryParams || []).filter(p => !p.required);

	for (const p of requiredQuery) {
		paramLines.push(`  ${p.name}: ${placeholderFromParam(p)},  // required, ${p.type}`);
	}
	// Show up to 2 optional params with defaults or enums
	const shownOptional = optionalQuery.filter(p => p.default !== undefined || p.enum).slice(0, 2);
	for (const p of shownOptional) {
		paramLines.push(`  // ${p.name}: ${placeholderFromParam(p)},  // optional, ${p.type}`);
	}

	const paramsBlock = paramLines.length > 0 ? `{\n${paramLines.join("\n")}\n}` : "";

	let code: string;
	if (ep.method === "POST" && ep.body) {
		const bodyHint = ep.body.description || "{ /* request body */ }";
		code = paramsBlock
			? `const result = await ${method}("${ep.path}", ${bodyHint}, ${paramsBlock});`
			: `const result = await ${method}("${ep.path}", ${bodyHint});`;
	} else {
		code = paramsBlock
			? `const result = await ${method}("${ep.path}", ${paramsBlock});`
			: `const result = await ${method}("${ep.path}");`;
	}

	if (ep.responseShape) {
		code += `\n// Returns: ${ep.responseShape}`;
	}

	return code;
}

/**
 * Generate a code example from an OpenAPI operation.
 */
export function generateOperationStub(op: OpenApiOperation): string {
	const method = op.method.toLowerCase() === "get" ? "api.get" : "api.post";
	const params = op.parameters || [];

	const pathParams = params.filter(p => p.in === "path");
	const queryParams = params.filter(p => p.in === "query");
	const requiredQuery = queryParams.filter(p => p.required);
	const optionalQuery = queryParams.filter(p => !p.required);

	const paramLines: string[] = [];

	for (const p of pathParams) {
		paramLines.push(`  ${p.name}: ${placeholderFromOpenApiParam(p)},  // path, required`);
	}
	for (const p of requiredQuery) {
		paramLines.push(`  ${p.name}: ${placeholderFromOpenApiParam(p)},  // required`);
	}
	const shownOptional = optionalQuery.filter(p =>
		p.schema?.default !== undefined || p.schema?.enum || p.example !== undefined
	).slice(0, 2);
	for (const p of shownOptional) {
		paramLines.push(`  // ${p.name}: ${placeholderFromOpenApiParam(p)},  // optional`);
	}

	const paramsBlock = paramLines.length > 0 ? `{\n${paramLines.join("\n")}\n}` : "";

	if (op.method.toLowerCase() === "post" && op.requestBody) {
		const bodyHint = "{ /* request body */ }";
		return paramsBlock
			? `const result = await ${method}("${op.path}", ${bodyHint}, ${paramsBlock});`
			: `const result = await ${method}("${op.path}", ${bodyHint});`;
	}

	return paramsBlock
		? `const result = await ${method}("${op.path}", ${paramsBlock});`
		: `const result = await ${method}("${op.path}");`;
}

/**
 * Generate a compact one-line-per-endpoint quick reference for the tool description.
 * Prioritizes non-deprecated, non-coveredByTool endpoints.
 */
export function generateQuickReference(options: {
	catalog?: ApiCatalog;
	openApiSpec?: { paths: Record<string, Record<string, unknown>> };
	max?: number;
	prefix?: string;
}): string {
	const max = options.max || 10;
	const prefix = options.prefix || "api";

	if (options.catalog) {
		return generateCatalogQuickRef(options.catalog, max, prefix);
	}
	if (options.openApiSpec) {
		return generateOpenApiQuickRef(options.openApiSpec, max, prefix);
	}
	return "";
}

function generateCatalogQuickRef(catalog: ApiCatalog, max: number, prefix: string): string {
	// Prioritize: non-deprecated, non-coveredByTool, required params first
	const sorted = [...catalog.endpoints]
		.filter(ep => !ep.deprecated)
		.sort((a, b) => {
			// Uncovered endpoints first (they're only accessible via Code Mode)
			if (!a.coveredByTool && b.coveredByTool) return -1;
			if (a.coveredByTool && !b.coveredByTool) return 1;
			// More required params = more useful to show
			const aReq = (a.pathParams?.length ?? 0) + (a.queryParams?.filter(p => p.required)?.length ?? 0);
			const bReq = (b.pathParams?.length ?? 0) + (b.queryParams?.filter(p => p.required)?.length ?? 0);
			return bReq - aReq;
		})
		.slice(0, max);

	const lines = sorted.map(ep => {
		const params = [
			...(ep.pathParams || []).map(p => `${p.name}*`),
			...(ep.queryParams || []).filter(p => p.required).map(p => `${p.name}*`),
			...(ep.queryParams || []).filter(p => !p.required).slice(0, 2).map(p => `${p.name}?`),
		];
		const paramStr = params.length > 0 ? ` (${params.join(", ")})` : "";
		return `  ${ep.method} ${ep.path} — ${ep.summary}${paramStr}`;
	});

	return `QUICK REFERENCE (use ${prefix}_search for full docs):\n${lines.join("\n")}`;
}

function generateOpenApiQuickRef(
	spec: { paths: Record<string, Record<string, unknown>> },
	max: number,
	prefix: string,
): string {
	const methods = ["get", "post", "put", "delete", "patch"];
	const ops: Array<{ method: string; path: string; summary: string; params: OpenApiParameter[] }> = [];

	for (const [path, pathItem] of Object.entries(spec.paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		for (const method of methods) {
			const op = (pathItem as Record<string, unknown>)[method];
			if (!op || typeof op !== "object") continue;
			const opObj = op as Record<string, unknown>;
			ops.push({
				method: method.toUpperCase(),
				path,
				summary: (opObj.summary as string) || "",
				params: (opObj.parameters as OpenApiParameter[]) || [],
			});
		}
	}

	const selected = ops.slice(0, max);
	const lines = selected.map(op => {
		const required = op.params.filter(p => p.required).map(p => `${p.name}*`);
		const optional = op.params.filter(p => !p.required).slice(0, 2).map(p => `${p.name}?`);
		const params = [...required, ...optional];
		const paramStr = params.length > 0 ? ` (${params.join(", ")})` : "";
		return `  ${op.method} ${op.path} — ${op.summary}${paramStr}`;
	});

	return `QUICK REFERENCE (use ${prefix}_search for full docs):\n${lines.join("\n")}`;
}

// ── Type Hints ──────────────────────────────────────────────────────────

/**
 * Format a ParamDef type as a concise TS-style annotation.
 */
function formatParamType(p: ParamDef): string {
	if (p.enum && p.enum.length > 0) {
		const vals = p.enum.slice(0, 5).map(v => JSON.stringify(v));
		if (p.enum.length > 5) vals.push("...");
		return vals.join(" | ");
	}
	return p.type || "string";
}

/**
 * Format an OpenAPI parameter type as a concise TS-style annotation.
 */
function formatOpenApiParamType(p: OpenApiParameter): string {
	if (p.schema?.enum && p.schema?.enum.length > 0) {
		const vals = p.schema?.enum.slice(0, 5).map(v => JSON.stringify(v));
		if (p.schema?.enum.length > 5) vals.push("...");
		return vals.join(" | ");
	}
	return p.schema?.type || p.type || "string";
}

/**
 * Format a single endpoint as a TypeScript-style type hint.
 */
function formatEndpointTypeHint(ep: ApiEndpoint): string {
	const method = ep.method === "GET" ? "api.get" : "api.post";
	const allParams = [
		...(ep.pathParams || []).map(p => `${p.name}${p.required ? "" : "?"}: ${formatParamType(p)}`),
		...(ep.queryParams || []).filter(p => p.required).map(p => `${p.name}: ${formatParamType(p)}`),
		...(ep.queryParams || []).filter(p => !p.required).map(p => `${p.name}?: ${formatParamType(p)}`),
	];
	const params = allParams.length > 0 ? `{ ${allParams.join("; ")} }` : "";
	const ret = ep.responseShape || "object";
	const sig = params ? `${method}("${ep.path}", ${params})` : `${method}("${ep.path}")`;
	return `// ${sig} → ${ret}`;
}

/**
 * Format an OpenAPI operation as a TypeScript-style type hint.
 */
function formatOperationTypeHint(op: OpenApiOperation): string {
	const method = op.method.toLowerCase() === "get" ? "api.get" : "api.post";
	const params = op.parameters || [];
	const allParams = [
		...params.filter(p => p.required).map(p => `${p.name}: ${formatOpenApiParamType(p)}`),
		...params.filter(p => !p.required).map(p => `${p.name}?: ${formatOpenApiParamType(p)}`),
	];
	const paramStr = allParams.length > 0 ? `{ ${allParams.join("; ")} }` : "";
	const sig = paramStr ? `${method}("${op.path}", ${paramStr})` : `${method}("${op.path}")`;
	return `// ${sig} → object`;
}

/**
 * Generate TypeScript type hint comments for injection into V8 isolate preambles.
 *
 * These hints help the LLM understand parameter types, required vs optional,
 * enum values, and response shapes without needing to call _search first.
 *
 * Includes a note about staging for large responses.
 */
export function generateTypeHints(options: {
	catalog?: ApiCatalog;
	openApiSpec?: { paths: Record<string, Record<string, unknown>> };
	max?: number;
}): string {
	const max = options.max || 20;
	const lines: string[] = [
		"// === TYPE HINTS (auto-generated) ===",
		"// Large responses (>30KB) are auto-staged to SQLite.",
		"// The result will contain data_access_id — use query_data to access.",
		"",
	];

	if (options.catalog) {
		const endpoints = [...options.catalog.endpoints]
			.filter(ep => !ep.deprecated)
			.slice(0, max);
		for (const ep of endpoints) {
			lines.push(formatEndpointTypeHint(ep));
		}
	} else if (options.openApiSpec) {
		const methods = ["get", "post", "put", "delete", "patch"];
		let count = 0;
		for (const [path, pathItem] of Object.entries(options.openApiSpec.paths)) {
			if (count >= max) break;
			if (!pathItem || typeof pathItem !== "object") continue;
			for (const m of methods) {
				if (count >= max) break;
				const op = (pathItem as Record<string, unknown>)[m];
				if (!op || typeof op !== "object") continue;
				const opObj = op as OpenApiOperation;
				lines.push(formatOperationTypeHint({
					...opObj,
					path,
					method: m.toUpperCase(),
					parameters: (opObj.parameters as OpenApiParameter[]) || [],
				}));
				count++;
			}
		}
	}

	lines.push("// === END TYPE HINTS ===");
	return lines.join("\n");
}
