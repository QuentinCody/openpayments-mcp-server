/**
 * OpenAPI spec resolver — resolves $ref references and converts Swagger 2.0
 * to OpenAPI 3.0 format.
 *
 * Used to produce a self-contained, reference-free JSON spec that can be
 * injected into V8 isolates for Code Mode search tools.
 */

import type { ApiCatalog, ApiEndpoint, ParamDef } from "./catalog";

export interface ResolveOptions {
	/** Remove x-* extension fields from the output */
	stripExtensions?: boolean;
	/** Remove example/examples fields from the output */
	stripExamples?: boolean;
}

export interface ResolvedSpec {
	openapi: string;
	info: { title: string; version: string; [k: string]: unknown };
	servers?: Array<{ url: string; [k: string]: unknown }>;
	paths: Record<string, Record<string, unknown>>;
}

const OPERATION_METHODS = new Set([
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
	"trace",
]);

/**
 * Follow a JSON pointer path (e.g., "#/components/schemas/Study") through
 * the root document and return the referenced value.
 */
function followRef(root: unknown, refPath: string): unknown {
	if (!refPath.startsWith("#/")) {
		throw new Error(`Cannot resolve external $ref: ${refPath}`);
	}

	const segments = refPath.slice(2).split("/");
	let current: unknown = root;

	for (const segment of segments) {
		// JSON Pointer decoding: ~1 → /, ~0 → ~
		const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (current === null || current === undefined || typeof current !== "object") {
			throw new Error(`Cannot resolve $ref "${refPath}": path segment "${decoded}" not found`);
		}
		current = (current as Record<string, unknown>)[decoded];
	}

	if (current === undefined) {
		throw new Error(`Cannot resolve $ref "${refPath}": target not found`);
	}

	return current;
}

/**
 * Recursively resolve all $ref references in an object tree.
 *
 * Handles circular references by tracking visited ref paths and stopping
 * recursion when a cycle is detected.
 */
function resolveRefs(
	node: unknown,
	root: unknown,
	options: ResolveOptions,
	visited: Set<string>,
): unknown {
	if (node === null || node === undefined) return node;
	if (typeof node !== "object") return node;

	// Handle arrays
	if (Array.isArray(node)) {
		return node.map((item) => resolveRefs(item, root, options, visited));
	}

	// Handle objects
	const obj = node as Record<string, unknown>;

	// If this object is a $ref, resolve it
	if (typeof obj["$ref"] === "string") {
		const refPath = obj["$ref"] as string;

		// Guard against circular references
		if (visited.has(refPath)) {
			// Return a placeholder for circular refs
			return { _circular_ref: refPath };
		}

		const newVisited = new Set(visited);
		newVisited.add(refPath);

		const referenced = followRef(root, refPath);
		return resolveRefs(referenced, root, options, newVisited);
	}

	// Regular object — recurse into all properties
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		// Strip x-* extensions if configured
		if (options.stripExtensions && key.startsWith("x-")) {
			continue;
		}

		// Strip examples if configured
		if (options.stripExamples && (key === "example" || key === "examples")) {
			continue;
		}

		result[key] = resolveRefs(value, root, options, visited);
	}

	return result;
}

/**
 * Convert a Swagger 2.0 spec to OpenAPI 3.0 format.
 *
 * Only handles the top-level structural conversion (host/basePath/schemes → servers).
 * Parameter format differences are minimal enough to leave as-is for search purposes.
 */
function convertSwagger20(spec: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...spec };

	// Set OpenAPI version
	result.openapi = "3.0.0";
	delete result.swagger;

	// Convert host + basePath + schemes → servers
	const host = spec.host as string | undefined;
	const basePath = (spec.basePath as string) || "";
	const schemes = (spec.schemes as string[]) || ["https"];

	if (host) {
		const scheme = schemes[0] || "https";
		result.servers = [{ url: `${scheme}://${host}${basePath}` }];
	}

	// Remove Swagger 2.0-specific fields
	delete result.host;
	delete result.basePath;
	delete result.schemes;
	delete result.produces;
	delete result.consumes;

	return result;
}

/**
 * Resolve an OpenAPI/Swagger spec by inlining all $ref references.
 *
 * Supports:
 * - OpenAPI 3.0.x specs with $ref in parameters, schemas, responses
 * - Swagger 2.0 specs (auto-converted to OpenAPI 3.0 format)
 * - Nested and chained $ref resolution
 * - Circular reference detection
 * - Optional stripping of x-* extensions and examples
 *
 * @throws Error if a $ref cannot be resolved
 */
export function resolveOpenApiSpec(raw: unknown, options?: ResolveOptions): ResolvedSpec {
	const opts: ResolveOptions = options || {};

	if (raw === null || raw === undefined || typeof raw !== "object") {
		throw new Error("Invalid OpenAPI spec: must be an object");
	}

	let spec = raw as Record<string, unknown>;

	// Detect Swagger 2.0 and convert
	if (spec.swagger && typeof spec.swagger === "string" && spec.swagger.startsWith("2.")) {
		spec = convertSwagger20(spec);
	}

	// Ensure we have paths
	if (!spec.paths || typeof spec.paths !== "object") {
		spec = { ...spec, paths: {} };
	}

	// Resolve all $ref references (use original raw as the lookup root
	// since $refs point into the original document structure)
	const resolved = resolveRefs(spec, raw, opts, new Set()) as Record<string, unknown>;

	// Build the ResolvedSpec
	const info = (resolved.info || { title: "Unknown", version: "0.0" }) as ResolvedSpec["info"];
	const servers = resolved.servers as ResolvedSpec["servers"];
	const paths = (resolved.paths || {}) as ResolvedSpec["paths"];
	const openapi = (resolved.openapi || "3.0.0") as string;

	return {
		openapi,
		info,
		...(servers ? { servers } : {}),
		paths,
	};
}

function mergeParameterLists(
	existing: unknown,
	added: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const merged = Array.isArray(existing)
		? existing
			.filter((param): param is Record<string, unknown> => Boolean(param) && typeof param === "object")
			.map((param) => ({ ...param }))
		: [];
	const seen = new Set(
		merged.map((param) => `${String(param.name || "")}:${String(param.in || "")}`),
	);

	for (const param of added) {
		const key = `${String(param.name || "")}:${String(param.in || "")}`;
		if (seen.has(key)) continue;
		merged.push(param);
		seen.add(key);
	}

	return merged;
}

function createParameterSchema(param: ParamDef): Record<string, unknown> {
	const schema: Record<string, unknown> = { type: param.type };
	if (param.default !== undefined) schema.default = param.default;
	if (param.enum?.length) schema.enum = param.enum;
	if (param.type === "array") {
		schema.items = { type: "string" };
	}
	return schema;
}

function toOpenApiParameter(
	param: ParamDef,
	location: "path" | "query",
): Record<string, unknown> {
	return {
		name: param.name,
		in: location,
		required: location === "path" ? true : param.required,
		description: param.description,
		schema: createParameterSchema(param),
	};
}

function createRequestBody(endpoint: ApiEndpoint): Record<string, unknown> | undefined {
	if (!endpoint.body) return undefined;

	let schema: Record<string, unknown> = { type: "object" };
	if (endpoint.body.contentType.includes("text/plain")) {
		schema = { type: "string" };
	} else if (endpoint.body.contentType.includes("application/x-www-form-urlencoded")) {
		schema = { type: "object", additionalProperties: { type: "string" } };
	}

	return {
		description: endpoint.body.description,
		content: {
			[endpoint.body.contentType]: {
				schema,
			},
		},
	};
}

function buildOperationFromCatalog(endpoint: ApiEndpoint): Record<string, unknown> {
	const parameters = [
		...(endpoint.pathParams || []).map((param) => toOpenApiParameter(param, "path")),
		...(endpoint.queryParams || []).map((param) => toOpenApiParameter(param, "query")),
	];

	return {
		summary: endpoint.summary,
		...(endpoint.description ? { description: endpoint.description } : {}),
		tags: endpoint.category ? [endpoint.category] : [],
		...(parameters.length > 0 ? { parameters } : {}),
		...(createRequestBody(endpoint) ? { requestBody: createRequestBody(endpoint) } : {}),
		responses: {
			"200": {
				description: endpoint.response?.description || "Successful response",
			},
		},
	};
}

function mergeEndpointIntoOperation(
	existing: Record<string, unknown>,
	endpoint: ApiEndpoint,
): Record<string, unknown> {
	const merged = { ...existing };

	if (!merged.summary && endpoint.summary) merged.summary = endpoint.summary;
	if (!merged.description && endpoint.description) merged.description = endpoint.description;

	const tags = new Set(
		Array.isArray(merged.tags)
			? merged.tags.filter((tag): tag is string => typeof tag === "string")
			: [],
	);
	if (endpoint.category) tags.add(endpoint.category);
	if (tags.size > 0) merged.tags = Array.from(tags);

	const addedParameters = [
		...(endpoint.pathParams || []).map((param) => toOpenApiParameter(param, "path")),
		...(endpoint.queryParams || []).map((param) => toOpenApiParameter(param, "query")),
	];
	if (addedParameters.length > 0) {
		merged.parameters = mergeParameterLists(merged.parameters, addedParameters);
	}

	if (!merged.requestBody) {
		const requestBody = createRequestBody(endpoint);
		if (requestBody) merged.requestBody = requestBody;
	}

	if (!merged.responses) {
		merged.responses = buildOperationFromCatalog(endpoint).responses;
	}

	return merged;
}

/**
 * Merge legacy catalog endpoints into a resolved OpenAPI spec.
 *
 * This preserves partial published specs while retaining server-specific
 * endpoints and curated descriptions that only exist in catalog.ts.
 */
export function mergeCatalogIntoResolvedSpec(
	spec: ResolvedSpec,
	catalog: ApiCatalog,
): ResolvedSpec {
	const nextPaths: ResolvedSpec["paths"] = Object.fromEntries(
		Object.entries(spec.paths).map(([path, pathItem]) => [path, { ...pathItem }]),
	);

	for (const endpoint of catalog.endpoints) {
		const method = endpoint.method.toLowerCase();
		if (!OPERATION_METHODS.has(method)) continue;

		const pathItem = { ...(nextPaths[endpoint.path] || {}) };
		const existing = pathItem[method];

		pathItem[method] =
			existing && typeof existing === "object"
				? mergeEndpointIntoOperation(existing as Record<string, unknown>, endpoint)
				: buildOperationFromCatalog(endpoint);

		nextPaths[endpoint.path] = pathItem;
	}

	return {
		...spec,
		paths: nextPaths,
	};
}
