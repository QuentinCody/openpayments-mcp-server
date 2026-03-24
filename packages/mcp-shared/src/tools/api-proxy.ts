/**
 * Hidden __api_proxy tool — routes V8 isolate api.get/api.post calls
 * through the server's HTTP fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It validates paths, delegates to the server's ApiFetchFn, and
 * auto-stages large responses via stageToDoAndRespond().
 */

import { z } from "zod";
import type { ToolEntry } from "../registry/types";
import type { ApiCatalog, ApiFetchFn } from "../codemode/catalog";
import type { ResolvedSpec } from "../codemode/openapi-resolver";
import type { SchemaHints } from "../staging/schema-inference";
import { shouldStage, stageToDoAndRespond, queryDataFromDo } from "../staging/utils";

// ---------------------------------------------------------------------------
// Interfaces for untyped/loosely-typed structures used in this module
// ---------------------------------------------------------------------------

/** OpenAPI parameter object (subset of fields we inspect). */
interface SpecParameter {
	in?: string;
	name?: string;
}

/** OpenAPI operation object (subset of fields we inspect). */
interface SpecOperation {
	summary?: string;
	operationId?: string;
	parameters?: SpecParameter[];
}

// ---------------------------------------------------------------------------

/** Path traversal patterns to reject */
const DANGEROUS_PATTERNS = [
	/\.\.\//,      // Directory traversal
	/\/\.\./,      // Reverse traversal
	/%2e%2e/i,     // URL-encoded traversal
	/\/\//,        // Double slash
];

function validatePath(path: string): void {
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
function interpolatePath(
	path: string,
	params: Record<string, unknown>,
): { path: string; queryParams: Record<string, unknown> } {
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
function preserveEnvelopeScalars(
	original: unknown,
	staging: Record<string, unknown>,
): void {
	if (!original || typeof original !== "object" || Array.isArray(original)) {
		return;
	}
	// After the typeof guard, Object.entries is safe on the narrowed `object` type
	for (const [key, value] of Object.entries(original)) {
		if (key in staging) continue; // don't clobber staging metadata fields
		try {
			const serialized = JSON.stringify(value);
			if (serialized !== undefined && serialized.length <= ENVELOPE_SCALAR_LIMIT) {
				staging[key] = value;
			}
		} catch {
			// Skip non-serializable values
		}
	}
}

type DriftHintKind =
	| "unknown_endpoint"
	| "contract_changed"
	| "parameter_mismatch";

interface DriftHint {
	kind: DriftHintKind;
	message: string;
	suggestions?: Array<{ method: string; path: string; summary?: string }>;
	expected_params?: string[];
	known_methods?: string[];
}

interface KnownEndpoint {
	method: string;
	path: string;
	summary?: string;
	pathParamNames: string[];
	queryParamNames: string[];
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

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function extractCatalogEndpoints(catalog?: ApiCatalog): KnownEndpoint[] {
	if (!catalog) return [];

	return catalog.endpoints.map((endpoint) => ({
		method: endpoint.method.toUpperCase(),
		path: endpoint.path,
		summary: endpoint.summary,
		pathParamNames: (endpoint.pathParams || []).map((param) => param.name),
		queryParamNames: (endpoint.queryParams || []).map((param) => param.name),
	}));
}

function extractSpecParamNames(
	params: SpecParameter[],
	location: "path" | "query",
): string[] {
	return uniqueStrings(
		params.flatMap((param) => {
			if (param.in !== location || typeof param.name !== "string") return [];
			return [param.name];
		}),
	);
}

/** Type guard: checks that a value is an object with string keys (not null, not array). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractSpecEndpoints(spec?: ResolvedSpec): KnownEndpoint[] {
	if (!spec) return [];

	const endpoints: KnownEndpoint[] = [];
	for (const [path, pathItem] of Object.entries(spec.paths)) {
		if (!isRecord(pathItem)) continue;
		const pathParams: SpecParameter[] = Array.isArray(pathItem.parameters)
			? pathItem.parameters.filter(isRecord) as SpecParameter[]
			: [];

		for (const [method, operation] of Object.entries(pathItem)) {
			if (!HTTP_METHODS.has(method) || !isRecord(operation)) {
				continue;
			}

			const operationParams: SpecParameter[] = Array.isArray(operation.parameters)
				? operation.parameters.filter(isRecord) as SpecParameter[]
				: [];
			const mergedParams = [...pathParams, ...operationParams];

			endpoints.push({
				method: method.toUpperCase(),
				path,
				summary:
					typeof operation.summary === "string"
						? operation.summary
						: typeof operation.operationId === "string"
							? operation.operationId
							: undefined,
				pathParamNames: extractSpecParamNames(mergedParams, "path"),
				queryParamNames: extractSpecParamNames(mergedParams, "query"),
			});
		}
	}

	return endpoints;
}

function buildKnownEndpointIndex(
	catalog?: ApiCatalog,
	openApiSpec?: ResolvedSpec,
): KnownEndpoint[] {
	const merged = new Map<string, KnownEndpoint>();

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

function pathTemplateToRegExp(pathTemplate: string): RegExp {
	const escaped = pathTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`);
}

function pathMatches(requestPath: string, endpointPath: string): boolean {
	return requestPath === endpointPath || pathTemplateToRegExp(endpointPath).test(requestPath);
}

function pathSegments(path: string): string[] {
	return path
		.split("/")
		.filter(Boolean)
		.map((segment) => segment.toLowerCase())
		.map((segment) => (segment.startsWith("{") && segment.endsWith("}") ? "{}" : segment));
}

function scoreSuggestion(
	requestPath: string,
	method: string,
	endpoint: KnownEndpoint,
): number {
	const requestSegments = pathSegments(requestPath);
	const endpointSegments = pathSegments(endpoint.path);
	let score = endpoint.method === method ? 10 : 0;

	const sharedPrefix = Math.min(requestSegments.length, endpointSegments.length);
	for (let i = 0; i < sharedPrefix; i++) {
		if (requestSegments[i] === endpointSegments[i]) {
			score += 4;
		} else if (requestSegments[i] === "{}" || endpointSegments[i] === "{}") {
			score += 2;
		} else {
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

function buildSuggestions(
	requestPath: string,
	method: string,
	knownEndpoints: KnownEndpoint[],
): Array<{ method: string; path: string; summary?: string }> {
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

function buildDriftHint(
	method: string,
	requestPath: string,
	status: number,
	knownEndpoints: KnownEndpoint[],
): DriftHint | undefined {
	if (knownEndpoints.length === 0) return undefined;

	const normalizedMethod = method.toUpperCase();
	const exactMatches = knownEndpoints.filter(
		(endpoint) =>
			endpoint.method === normalizedMethod && pathMatches(requestPath, endpoint.path),
	);
	const pathMatchesAnyMethod = knownEndpoints.filter((endpoint) =>
		pathMatches(requestPath, endpoint.path),
	);

	if (exactMatches.length === 0) {
		const knownMethods = uniqueStrings(pathMatchesAnyMethod.map((endpoint) => endpoint.method));
		const suggestions = buildSuggestions(requestPath, normalizedMethod, knownEndpoints);
		const suggestionText = suggestions.length > 0
			? ` Try instead: ${suggestions
				.map((suggestion) => `${suggestion.method} ${suggestion.path}`)
				.join(", ")}.`
			: "";
		const methodText = knownMethods.length > 0
			? ` This path exists for methods: ${knownMethods.join(", ")}.`
			: "";

		return {
			kind: "unknown_endpoint",
			message:
				`Unknown endpoint: ${normalizedMethod} ${requestPath} does not exist.` +
				methodText +
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
			message:
				`${normalizedMethod} ${matchedEndpoint.path} matches current metadata, but the API returned ${status}. ` +
				`Expected path/query params include: ${expectedParams.join(", ")}. ` +
				`Re-run getEndpoint(${JSON.stringify(matchedEndpoint.path)}, ${JSON.stringify(normalizedMethod)}) ` +
				`or describeEndpoint(...) to verify names and required fields.`,
			expected_params: expectedParams,
		};
	}

	if ([404, 405, 410, 501].includes(status)) {
		const knownMethods = uniqueStrings(pathMatchesAnyMethod.map((endpoint) => endpoint.method));
		const hasPathParams = matchedEndpoint.pathParamNames.length > 0;

		// 404 on a parameterized path (e.g. /studies/{id}) almost always means
		// the specific resource doesn't exist, not that the endpoint is broken.
		if (status === 404 && hasPathParams) {
			return {
				kind: "contract_changed",
				message:
					`Resource not found: the upstream API returned 404 for ${normalizedMethod} ${requestPath}. ` +
					`The endpoint ${matchedEndpoint.path} exists but the requested resource was not found in the database. ` +
					`Verify the identifier is correct and exists in this data source.`,
			};
		}

		// 405/410/501 or 404 on a fixed path — likely an API contract change
		return {
			kind: "contract_changed",
			message:
				`${normalizedMethod} ${matchedEndpoint.path} returned ${status}. ` +
				(status === 405
					? `Method ${normalizedMethod} may not be allowed.`
					: `The endpoint may have been removed or renamed.`) +
				(knownMethods.length > 0 ? ` Known methods for this path: ${knownMethods.join(", ")}.` : ""),
			...(knownMethods.length > 0 ? { known_methods: knownMethods } : {}),
		};
	}

	return undefined;
}

export interface ApiProxyToolOptions {
	apiFetch: ApiFetchFn;
	/** Optional legacy catalog metadata for drift hints */
	catalog?: ApiCatalog;
	/** Optional resolved OpenAPI metadata for drift hints */
	openApiSpec?: ResolvedSpec;
	/** DO namespace for auto-staging large responses */
	doNamespace?: unknown;
	/** Prefix for data access IDs (e.g., "gtex") */
	stagingPrefix?: string;
	/** Byte threshold for auto-staging (default 100KB) */
	stagingThreshold?: number;
}

/**
 * Create the hidden __api_proxy tool entry.
 */
export function createApiProxyTool(options: ApiProxyToolOptions): ToolEntry {
	const {
		apiFetch,
		catalog,
		openApiSpec,
		doNamespace,
		stagingPrefix,
		stagingThreshold,
	} = options;
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
			const rawParams: Record<string, unknown> = isRecord(input.params) ? input.params : {};
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
				if (
					doNamespace &&
					stagingPrefix &&
					shouldStage(responseBytes, stagingThreshold)
				) {
					const staged = await stageToDoAndRespond(
						result.data,
						doNamespace as Parameters<typeof stageToDoAndRespond>[1],
						stagingPrefix,
						undefined,
						undefined,
						stagingPrefix,
					);
					const response: Record<string, unknown> = {
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
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = (err as { status?: number }).status || 500;
				const driftHint = buildDriftHint(
					method,
					interpolatedPath,
					status,
					knownEndpoints,
				);
				return {
					__api_error: true,
					status,
					message,
					data: (err as { data?: unknown }).data,
					...(driftHint ? { drift_hint: driftHint } : {}),
				};
			}
		},
	};
}

// ---------------------------------------------------------------------------
// __stage_proxy — routes db.stage() calls to the DO for arbitrary data staging
// ---------------------------------------------------------------------------

export interface StageProxyToolOptions {
	/** DO namespace for staging data */
	doNamespace: unknown;
	/** Prefix for data access IDs (e.g., "gtex") */
	stagingPrefix: string;
}

/**
 * Create the hidden __stage_proxy tool entry.
 * Stages arbitrary data from isolate db.stage() into the server's Durable Object.
 *
 * Accepts optional schema_hints from isolate code to control column types,
 * indexes, and other schema inference parameters. These are forwarded to the
 * DO's /process handler and merged with any server-side hints.
 */
export function createStageProxyTool(options: StageProxyToolOptions): ToolEntry {
	const { doNamespace, stagingPrefix } = options;

	return {
		name: "__stage_proxy",
		description: "Stage arbitrary data from V8 isolate into DO SQLite. Internal only.",
		hidden: true,
		schema: {
			data: z.unknown(),
			table_name: z.string().optional(),
			schema_hints: z.object({
				tableName: z.string().optional(),
				columnTypes: z.record(z.string(), z.string()).optional(),
				indexes: z.array(z.string()).optional(),
				exclude: z.array(z.string()).optional(),
				skipChildTables: z.array(z.string()).optional(),
				maxRecursionDepth: z.number().optional(),
				compositeIndexes: z.array(z.array(z.string())).optional(),
			}).optional(),
		},
		handler: async (input) => {
			const data = input.data;
			const tableName = input.table_name ? String(input.table_name) : undefined;
			const clientHints = input.schema_hints as SchemaHints | undefined;

			if (data === undefined || data === null) {
				return { __stage_error: true, message: "data is required" };
			}

			// Build merged schema hints: table_name is a shorthand for tableName
			const mergedHints: SchemaHints | undefined =
				tableName || clientHints
					? { ...clientHints, ...(tableName ? { tableName } : {}) }
					: undefined;

			try {
				const staged = await stageToDoAndRespond(
					data,
					doNamespace as Parameters<typeof stageToDoAndRespond>[1],
					stagingPrefix,
					mergedHints,
					undefined,
					stagingPrefix,
				);

				return {
					data_access_id: staged.dataAccessId,
					tables_created: staged.tablesCreated,
					total_rows: staged.totalRows,
					schema: staged.schema,
					_staging: staged._staging,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { __stage_error: true, message };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// __query_proxy — routes db.queryStaged / api.query calls to the DO
// ---------------------------------------------------------------------------

export interface QueryProxyToolOptions {
	/** DO namespace for querying staged data */
	doNamespace: unknown;
}

/**
 * Create the hidden __query_proxy tool entry.
 * Routes SQL queries from isolate api.query()/db.queryStaged() to the
 * Durable Object's /query endpoint via queryDataFromDo().
 */
export function createQueryProxyTool(options: QueryProxyToolOptions): ToolEntry {
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
				const result = await queryDataFromDo(
					doNamespace as DurableObjectNamespace,
					dataAccessId,
					sql,
					1000,
				);
				const queryResult = result as Record<string, unknown>;
				return {
					rows: result.rows,
					row_count: result.row_count,
					...(queryResult.truncated !== undefined ? { truncated: queryResult.truncated } : {}),
					...(queryResult.total_matching !== undefined ? { total_matching: queryResult.total_matching } : {}),
					sql: result.sql,
					data_access_id: result.data_access_id,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { __query_error: true, message };
			}
		},
	};
}
