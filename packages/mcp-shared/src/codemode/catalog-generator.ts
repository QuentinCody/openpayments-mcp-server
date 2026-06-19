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

import type {
	ApiCatalog,
	ApiEndpoint,
	ParamDef,
	WorkflowRecipe,
} from "./catalog";
import type { ResolvedSpec } from "./openapi-resolver";

// ── Types ────────────────────────────────────────────────────────────────

export interface CatalogDiagnostic {
	level: "info" | "warn" | "error";
	message: string;
	path?: string;
	method?: string;
}

export interface CatalogGeneratorResult {
	catalog: ApiCatalog;
	diagnostics: CatalogDiagnostic[];
}

/** Override for a single endpoint, keyed by "METHOD /path" */
export interface EndpointOverride extends Partial<Omit<ApiEndpoint, "method" | "path">> {
	/** Remove this endpoint from the catalog */
	exclude?: boolean;
}

export interface CatalogOverrides {
	/** Per-endpoint overrides, keyed by "METHOD /path" (e.g. "GET /studies/{nctId}") */
	endpoints?: Record<string, EndpointOverride>;
	/** Paths to exclude entirely */
	exclude?: string[];
	/** If set, only include these paths (allowlist) */
	include?: string[];
	/** Rename OpenAPI tags to categories */
	categoryMap?: Record<string, string>;
	/** Additional endpoints not in the source */
	additionalEndpoints?: ApiEndpoint[];
	/** Workflow recipes to add */
	workflows?: WorkflowRecipe[];
	/** Override catalog-level fields */
	catalog?: Partial<Pick<ApiCatalog, "name" | "baseUrl" | "version" | "auth" | "notes">>;
}

export type CategoryStrategy = "tag" | "path-prefix" | "operationId";

export interface OpenApiToCatalogOptions {
	name?: string;
	baseUrl?: string;
	auth?: string;
	notes?: string;
	categoryStrategy?: CategoryStrategy;
	includeExamples?: boolean;
	/** Include deprecated endpoints (marked with deprecated: true) */
	includeDeprecated?: boolean;
}

export interface GraphQlToCatalogOptions {
	name: string;
	baseUrl: string;
	auth?: string;
	notes?: string;
}

// ── Schema → Response Shape ──────────────────────────────────────────────

const MAX_SHAPE_DEPTH = 4;
const MAX_SHAPE_PROPERTIES = 12;

/** Merge allOf sub-schemas into a single object schema (properties + required). */
function mergeAllOfSchemas(subSchemas: Record<string, unknown>[]): Record<string, unknown> {
	const merged: Record<string, unknown> = { type: "object", properties: {}, required: [] };
	for (const sub of subSchemas) {
		if (sub.properties && typeof sub.properties === "object") {
			Object.assign(merged.properties as object, sub.properties);
		}
		if (Array.isArray(sub.required)) {
			(merged.required as string[]).push(...(sub.required as string[]));
		}
	}
	return merged;
}

/** Render the object/default branch: named properties, Record<> maps, or any/object fallbacks. */
function objectShapeFromSchema(s: Record<string, unknown>, depth: number): string {
	if (s.type && s.type !== "object" && !s.properties) return "any";
	const props = s.properties;
	if (!props || typeof props !== "object") {
		if (s.additionalProperties && typeof s.additionalProperties === "object") {
			return `Record<string, ${schemaToResponseShape(s.additionalProperties, depth + 1)}>`;
		}
		return s.properties === undefined && !s.type ? "any" : "object";
	}
	const entries = Object.entries(props as Record<string, unknown>);
	const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
	const parts = entries.slice(0, MAX_SHAPE_PROPERTIES).map(([key, val]) => {
		const opt = required.has(key) ? "" : "?";
		return `${key}${opt}: ${schemaToResponseShape(val, depth + 1)}`;
	});
	const ellipsis = entries.length > MAX_SHAPE_PROPERTIES ? ", ..." : "";
	return `{ ${parts.join(", ")}${ellipsis} }`;
}

/**
 * Convert an OpenAPI/JSON-Schema object to a TypeScript-like shape string.
 * E.g. `{ id: string, items: Array<{ name: string, count: number }> }`
 */
export function schemaToResponseShape(schema: unknown, depth = 0): string {
	if (!schema || typeof schema !== "object" || depth > MAX_SHAPE_DEPTH) return "any";
	const s = schema as Record<string, unknown>;

	// Union types
	if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
		const variants = (s.oneOf || s.anyOf) as unknown[];
		return variants
			.slice(0, 4)
			.map((v) => schemaToResponseShape(v, depth + 1))
			.join(" | ");
	}

	// Intersection/composition
	if (Array.isArray(s.allOf)) {
		return schemaToResponseShape(mergeAllOfSchemas(s.allOf as Record<string, unknown>[]), depth);
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
		default:
			// "object", absent, or anything else falls through to the object renderer
			return objectShapeFromSchema(s, depth);
	}
}

// ── Parameter Helpers ────────────────────────────────────────────────────

function mapSchemaType(schema: unknown): ParamDef["type"] {
	if (!schema || typeof schema !== "object") return "string";
	const s = schema as Record<string, unknown>;
	const type = s.type as string | undefined;
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

function extractParam(raw: Record<string, unknown>, location: "path" | "query"): ParamDef | null {
	if (raw.in !== location) return null;
	const schema = (raw.schema || {}) as Record<string, unknown>;
	const param: ParamDef = {
		name: String(raw.name || ""),
		type: mapSchemaType(schema.type ? schema : raw),
		required: location === "path" ? true : Boolean(raw.required),
		description: String(raw.description || schema.description || raw.name || ""),
	};
	const def = raw.default ?? schema.default;
	if (def !== undefined) param.default = def;
	const enm = (raw.enum || schema.enum) as unknown[] | undefined;
	if (enm?.length) param.enum = enm;
	return param;
}

// ── Category Derivation ──────────────────────────────────────────────────

function deriveCategory(
	operation: Record<string, unknown>,
	pathStr: string,
	strategy: CategoryStrategy,
): string {
	switch (strategy) {
		case "tag": {
			const tags = operation.tags as string[] | undefined;
			return tags?.[0]?.toLowerCase().replace(/\s+/g, "_") || "general";
		}
		case "path-prefix": {
			const segments = pathStr.split("/").filter(Boolean);
			const meaningful = segments.find(
				(s) => !/^(v\d+|api|rest|json)$/i.test(s) && !s.startsWith("{"),
			);
			return meaningful?.toLowerCase() || "general";
		}
		case "operationId": {
			const id = (operation.operationId || "") as string;
			const match = id.match(
				/^(?:get|post|put|delete|list|create|update|search|find)(.+)/i,
			);
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
export function openApiToCatalog(
	spec: ResolvedSpec,
	options?: OpenApiToCatalogOptions,
): CatalogGeneratorResult {
	const opts = options || {};
	const strategy = opts.categoryStrategy || "tag";
	const includeExamples = opts.includeExamples ?? false;
	const includeDeprecated = opts.includeDeprecated ?? true;
	const diagnostics: CatalogDiagnostic[] = [];
	const endpoints: ApiEndpoint[] = [];

	for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		const pathRecord = pathItem as Record<string, unknown>;

		// Path-level parameters
		const pathLevelParams = Array.isArray(pathRecord.parameters)
			? (pathRecord.parameters as Record<string, unknown>[])
			: [];

		for (const [method, value] of Object.entries(pathRecord)) {
			if (!value || typeof value !== "object") continue;
			const op = value as Record<string, unknown>;

			if (method === "patch") {
				const mapped = buildPatchAsPut(pathStr, op, pathLevelParams, strategy, includeExamples, includeDeprecated);
				diagnostics.push(...mapped.diagnostics);
				if (mapped.endpoint) endpoints.push(mapped.endpoint);
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

			if (!SUPPORTED_METHODS.has(method)) continue;

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
				? (op.parameters as Record<string, unknown>[])
				: [];
			const endpoint = buildEndpointFromOperation(
				method.toUpperCase() as ApiEndpoint["method"],
				pathStr,
				op,
				mergeParams(pathLevelParams, opParams),
				strategy,
				includeExamples,
			);

			if (endpoint) {
				if (op.deprecated) endpoint.deprecated = true;
				endpoints.push(endpoint);
			}
		}
	}

	return assembleOpenApiCatalog(spec, opts, endpoints, diagnostics);
}

/**
 * Map a PATCH operation onto a PUT endpoint, tagging its description.
 * Note: unlike the regular path, PATCH params are concatenated (not deduped
 * via mergeParams) — long-standing behavior preserved.
 */
function buildPatchAsPut(
	pathStr: string,
	op: Record<string, unknown>,
	pathLevelParams: Record<string, unknown>[],
	strategy: CategoryStrategy,
	includeExamples: boolean,
	includeDeprecated: boolean,
): { endpoint: ApiEndpoint | null; diagnostics: CatalogDiagnostic[] } {
	const diagnostics: CatalogDiagnostic[] = [];
	const opParams = Array.isArray(op.parameters)
		? (op.parameters as Record<string, unknown>[])
		: [];

	const endpoint = buildEndpointFromOperation(
		"PUT",
		pathStr,
		{
			...op,
			description: op.description
				? `[Originally PATCH] ${op.description}`
				: "[Originally PATCH]",
		} as Record<string, unknown>,
		[...pathLevelParams, ...opParams],
		strategy,
		includeExamples,
	);

	if (!endpoint) return { endpoint: null, diagnostics };

	if (op.deprecated && !includeDeprecated) {
		diagnostics.push({
			level: "info",
			message: "Skipped deprecated PATCH endpoint (mapped to PUT)",
			path: pathStr,
			method: "PATCH",
		});
		return { endpoint: null, diagnostics };
	}

	if (op.deprecated) endpoint.deprecated = true;
	diagnostics.push({
		level: "info",
		message: "Mapped PATCH to PUT",
		path: pathStr,
		method: "PATCH",
	});
	return { endpoint, diagnostics };
}

/** Sort endpoints, derive the base URL, and assemble the catalog envelope. */
function assembleOpenApiCatalog(
	spec: ResolvedSpec,
	opts: OpenApiToCatalogOptions,
	endpoints: ApiEndpoint[],
	diagnostics: CatalogDiagnostic[],
): CatalogGeneratorResult {
	// Sort by category then path
	endpoints.sort(
		(a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path),
	);

	const specBaseUrl = spec.servers?.[0]?.url || "";

	const catalog: ApiCatalog = {
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

function mergeParams(
	pathLevel: Record<string, unknown>[],
	opLevel: Record<string, unknown>[],
): Record<string, unknown>[] {
	const map = new Map<string, Record<string, unknown>>();
	for (const p of pathLevel) map.set(`${p.in}:${p.name}`, p);
	for (const p of opLevel) map.set(`${p.in}:${p.name}`, p); // op-level overrides
	return Array.from(map.values());
}

/** Extract the request-body descriptor (first content type wins). */
function extractRequestBody(op: Record<string, unknown>): ApiEndpoint["body"] | undefined {
	const requestBody = op.requestBody as Record<string, unknown> | undefined;
	if (!requestBody?.content || typeof requestBody.content !== "object") return undefined;
	const contentTypes = Object.keys(requestBody.content as object);
	return {
		contentType: contentTypes[0] || "application/json",
		...(requestBody.description ? { description: String(requestBody.description) } : {}),
	};
}

interface ResponseInfo {
	responseShape?: string;
	responseDesc?: string;
	responseExample?: unknown;
}

/** Pull the success response's shape/description/example from an operation. */
function extractResponseInfo(op: Record<string, unknown>, includeExamples: boolean): ResponseInfo {
	const info: ResponseInfo = {};
	const responses = op.responses as Record<string, unknown> | undefined;
	if (!responses) return info;

	const successKey =
		["200", "201"].find((k) => responses[k]) ||
		Object.keys(responses).find((k) => k.startsWith("2"));
	if (!successKey) return info;

	const resp = responses[successKey] as Record<string, unknown>;
	info.responseDesc = resp.description as string | undefined;
	const content = resp.content as Record<string, unknown> | undefined;
	if (!content) return info;

	const mediaType = (content["application/json"] ||
		Object.values(content)[0]) as Record<string, unknown> | undefined;
	if (mediaType?.schema) {
		const shape = schemaToResponseShape(mediaType.schema);
		// "any"/"object" are not informative enough to surface
		if (shape !== "any" && shape !== "object") info.responseShape = shape;
	}
	if (includeExamples && mediaType?.example) {
		info.responseExample = mediaType.example;
	}
	return info;
}

function buildEndpointFromOperation(
	method: ApiEndpoint["method"],
	pathStr: string,
	op: Record<string, unknown>,
	allParams: Record<string, unknown>[],
	strategy: CategoryStrategy,
	includeExamples: boolean,
): ApiEndpoint | null {
	const summary = String(
		op.summary || op.operationId || `${method} ${pathStr}`,
	);

	const pathParams = allParams
		.map((p) => extractParam(p, "path"))
		.filter((p): p is ParamDef => p !== null);
	const queryParams = allParams
		.map((p) => extractParam(p, "query"))
		.filter((p): p is ParamDef => p !== null);

	const body = extractRequestBody(op);
	const { responseShape, responseDesc, responseExample } = extractResponseInfo(op, includeExamples);

	const description = op.description as string | undefined;
	const category = deriveCategory(op, pathStr, strategy);

	const endpoint: ApiEndpoint = {
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

// GraphQL introspection → ApiCatalog (Tier 3) lives in ./graphql-catalog
// (extracted for the file-size cap); re-exported so import sites keep working.
export { graphQlToCatalog } from "./graphql-catalog";

// ── Manual Definition → ApiCatalog (Tier 4) ──────────────────────────────

/**
 * Validate and normalize a manually-defined catalog from JSON/YAML.
 * Fills in defaults, normalizes types, and sets endpointCount.
 */
export function normalizeManualCatalog(raw: unknown): CatalogGeneratorResult {
	const diagnostics: CatalogDiagnostic[] = [];

	if (!raw || typeof raw !== "object") {
		return {
			catalog: { name: "API", baseUrl: "", endpointCount: 0, endpoints: [] },
			diagnostics: [{ level: "error", message: "Manual catalog must be an object" }],
		};
	}

	const def = raw as Record<string, unknown>;
	const rawEndpoints = Array.isArray(def.endpoints) ? def.endpoints : [];

	const endpoints: ApiEndpoint[] = rawEndpoints.map((ep: unknown, i: number) => {
		if (!ep || typeof ep !== "object") {
			diagnostics.push({ level: "warn", message: `Endpoint ${i} is not an object, skipped` });
			return null as unknown as ApiEndpoint;
		}
		const e = ep as Record<string, unknown>;
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
				: "GET") as ApiEndpoint["method"],
			path: String(e.path || "/"),
			summary: String(e.summary || ""),
			...(e.description ? { description: String(e.description) } : {}),
			category: String(e.category || "general"),
			...(Array.isArray(e.pathParams) ? { pathParams: e.pathParams.map(normalizeParam) } : {}),
			...(Array.isArray(e.queryParams)
				? { queryParams: e.queryParams.map(normalizeParam) }
				: {}),
			...(e.body && typeof e.body === "object" ? { body: e.body as ApiEndpoint["body"] } : {}),
			...(e.response && typeof e.response === "object"
				? { response: e.response as ApiEndpoint["response"] }
				: {}),
			...(e.responseShape ? { responseShape: String(e.responseShape) } : {}),
			...(e.coveredByTool ? { coveredByTool: String(e.coveredByTool) } : {}),
			...(e.deprecated ? { deprecated: true } : {}),
			...(e.example ? { example: String(e.example) } : {}),
			...(e.usageHint ? { usageHint: String(e.usageHint) } : {}),
		};
	}).filter(Boolean);

	const catalog: ApiCatalog = {
		name: String(def.name || "API"),
		baseUrl: String(def.baseUrl || ""),
		...(def.version ? { version: String(def.version) } : {}),
		endpointCount: endpoints.length,
		...(def.auth ? { auth: String(def.auth) } : {}),
		...(def.notes ? { notes: String(def.notes) } : {}),
		endpoints,
		...(Array.isArray(def.workflows) ? { workflows: def.workflows as WorkflowRecipe[] } : {}),
	};

	return { catalog, diagnostics };
}

function normalizeParam(p: unknown): ParamDef {
	if (!p || typeof p !== "object") {
		return { name: "", type: "string", required: false, description: "" };
	}
	const raw = p as Record<string, unknown>;
	return {
		name: String(raw.name || ""),
		type: (["string", "number", "boolean", "array"].includes(String(raw.type))
			? String(raw.type)
			: "string") as ParamDef["type"],
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
export function applyOverrides(
	catalog: ApiCatalog,
	overrides: CatalogOverrides,
): CatalogGeneratorResult {
	const diagnostics: CatalogDiagnostic[] = [];
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
	const matchedKeys = new Set<string>();
	if (overrides.endpoints) {
		endpoints = endpoints
			.map((ep) => {
				const key = `${ep.method} ${ep.path}`;
				const override = overrides.endpoints?.[key];
				if (!override) return ep;
				matchedKeys.add(key);
				if (override.exclude) {
					diagnostics.push({ level: "info", message: `Excluded: ${key}` });
					return null;
				}
				// Shallow merge — override fields replace, undefined fields keep original
				const { exclude: _, ...fields } = override;
				return { ...ep, ...fields };
			})
			.filter((ep): ep is ApiEndpoint => ep !== null);

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
	const result: ApiCatalog = {
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

// ── Format Detection ─────────────────────────────────────────────────────

export type DetectedFormat = "openapi" | "graphql" | "manual";

/** Auto-detect the source format from a parsed object. */
export function detectFormat(source: unknown): DetectedFormat {
	if (!source || typeof source !== "object") return "manual";
	const obj = source as Record<string, unknown>;

	// OpenAPI 3.x or Swagger 2.x
	if (obj.openapi || obj.swagger || obj.paths) return "openapi";

	// GraphQL introspection
	if (obj.__schema || (obj.data && typeof obj.data === "object" && (obj.data as Record<string, unknown>).__schema)) {
		return "graphql";
	}

	return "manual";
}

// ── TypeScript Source Writer ─────────────────────────────────────────────

/**
 * Generate a TypeScript source file from an ApiCatalog.
 * Produces a complete .ts file with import and export.
 */
export function generateCatalogTypeScript(
	catalog: ApiCatalog,
	options: {
		exportName: string;
		sourceLabel?: string;
	},
): string {
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
