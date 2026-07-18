/**
 * Hidden __api_proxy tool — routes V8 isolate api.get/api.post calls
 * through the server's HTTP fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It validates paths, delegates to the server's ApiFetchFn, and
 * auto-stages large responses via stageToDoAndRespond().
 */

import { z } from "zod";
import type { ApiCatalog, ApiFetchFn } from "../codemode/catalog";
import type { ResolvedSpec } from "../codemode/openapi-resolver";
import { inferUpstreamTotal } from "../completeness";
import type { ToolContext, ToolEntry } from "../registry/types";
import type { SchemaHints } from "../staging/schema-inference";
import { effectiveStagingThreshold } from "../staging/single-record";
import { clampLimit } from "../staging/sql-guard";
import {
	queryDataFromDo,
	type StageOptions,
	shouldStage,
	stageToDoAndRespond,
} from "../staging/utils";
import {
	buildDriftHint,
	buildKnownEndpointIndex,
	preflightUnknownEndpoint,
} from "./api-proxy-drift";
import { boundedErrorData, TRANSPORT_LIMIT } from "./passthrough-limits";
import { buildStagedEnvelope, extractStagedColumns } from "./staging-envelope";

// `extractStagedColumns` is re-exported so the long-standing
// `import { extractStagedColumns } from "./api-proxy"` sites (and its colocated
// test) stay stable; the envelope helpers themselves live in ./staging-envelope.
export { extractStagedColumns };

// ---------------------------------------------------------------------------

/** Path traversal patterns to reject */
const DANGEROUS_PATTERNS = [
	/\.\.\//, // Directory traversal
	/\/\.\./, // Reverse traversal
	/%2e%2e/i, // URL-encoded traversal
	/\/\//, // Double slash
];

export function validatePath(path: string): void {
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
 *
 * A token may repeat: WikiPathways' asset URLs look like
 * `/pathways/{pwId}/{pwId}.json`. Read the value from the ORIGINAL `params` and
 * only consume it from the `queryParams` copy — reading the copy meant the
 * second `{pwId}` saw a key the first had just deleted and threw
 * "Missing required path parameter: pwId" for a param that WAS supplied.
 */
export function interpolatePath(
	path: string,
	params: Record<string, unknown>,
): { path: string; queryParams: Record<string, unknown> } {
	const queryParams = { ...params };
	// `[^{}]+` not `\w+`: a token may contain non-word chars (`{gene-id}`), which
	// `\w+` left unsubstituted. `Object.hasOwn` not a bare lookup: `{toString}`
	// would otherwise resolve to Object.prototype.toString instead of "missing".
	const interpolated = path.replace(/\{([^{}]+)\}/g, (_match, key) => {
		const value = Object.hasOwn(params, key) ? params[key] : undefined;
		if (value === undefined || value === null) {
			throw new Error(`Missing required path parameter: ${key}`);
		}
		delete queryParams[key];
		return encodeURIComponent(String(value));
	});
	return { path: interpolated, queryParams };
}

/** Type guard: checks that a value is an object with string keys (not null, not array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build the {@link StageOptions} for a proxy staging call. When the request is
 * workspace-scoped (`ctx.workspace` set AND the server wired a
 * `workspaceNamespace`), route staging into the shared WorkspaceDO under the
 * server's `stagingPrefix` as the dataset name (ADR-006 Phase 0). Otherwise
 * return the plain per-server options — byte-for-byte unchanged.
 */
export function buildStageOptions(
	ctx: ToolContext | undefined,
	workspaceNamespace: unknown,
	stagingPrefix: string,
	upstreamTotal?: number,
): StageOptions {
	const workspace = ctx?.workspace;
	if (workspace && workspaceNamespace) {
		return {
			upstreamTotal,
			workspace: {
				namespace: workspaceNamespace,
				id: workspace,
				dataset: stagingPrefix,
			},
		};
	}
	return { upstreamTotal };
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
	/** Byte threshold for auto-staging (default 30KB, via DEFAULT_STAGING_THRESHOLD) */
	stagingThreshold?: number;
	/** WorkspaceDO namespace — when set and `ctx.workspace` is present, auto-staging routes there (ADR-006 Phase 0). */
	workspaceNamespace?: unknown;
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
		workspaceNamespace,
	} = options;
	const knownEndpoints = buildKnownEndpointIndex(catalog, openApiSpec);

	return {
		name: "__api_proxy",
		description:
			"Route API calls from V8 isolate through server HTTP layer. Internal only.",
		hidden: true,
		schema: {
			method: z.enum(["GET", "POST", "PUT", "DELETE"]),
			path: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
			body: z.unknown().optional(),
		},
		handler: async (input, ctx) => {
			const method = String(input.method || "GET");
			const rawPath = String(input.path || "/");
			const rawParams: Record<string, unknown> = isRecord(input.params)
				? input.params
				: {};
			const body = input.body;
			let interpolatedPath = rawPath;

			try {
				validatePath(rawPath);

				// Interpolate path params and extract remaining as query params
				const { path, queryParams } = interpolatePath(rawPath, rawParams);
				interpolatedPath = path;
				validatePath(path); // #2 — re-check post-interpolation: a param can inject .. traversal

				// T1.1 — pre-flight path check. When the path is almost certainly a
				// hallucination (no known endpoint matches it, but a sibling under the
				// same first segment exists), fail LOCALLY with the structured drift
				// hint and ZERO upstream round-trip. Servers with no catalog/spec, real
				// endpoint paths, and wholly-novel paths fall through untouched.
				const preflight = preflightUnknownEndpoint(
					method,
					path,
					knownEndpoints,
				);
				if (preflight) {
					return {
						__api_error: true,
						status: 404,
						code: "UNKNOWN_ENDPOINT",
						attempted: `${method} ${path}`,
						message: preflight.message,
						...(preflight.suggestions?.[0]
							? { closest_match: preflight.suggestions[0] }
							: {}),
						drift_hint: preflight,
						preflight: true,
					};
				}

				const result = await apiFetch({
					method,
					path,
					params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
					body,
				});

				// A resolved non-2xx is a FAILURE (the catch only fires on THROW) — an
				// adapter that RETURNS {status:502,data} else surfaces it as data with a
				// citation, the systemic clingen-class silent failure (doc 09/11).
				if (typeof result.status === "number" && result.status >= 400) {
					const dh = buildDriftHint(method, path, result.status, knownEndpoints);
					return { __api_error: true, incomplete: true, status: result.status, message: `Upstream returned HTTP ${result.status}`, data: boundedErrorData(result.data), ...(dh ? { drift_hint: dh } : {}) };
				}

				// T10.1 — a SINGLE record gets a raised staging threshold so it stays
				// inline. undefined data (a 204 no-content) sizes to 0, not a throw (#7).
				const responseBytes = result.data === undefined ? 0 : JSON.stringify(result.data).length;
				if (
					doNamespace &&
					stagingPrefix &&
					shouldStage(
						responseBytes,
						effectiveStagingThreshold(result.data, stagingThreshold),
					)
				) {
					// upstreamTotal powers the under-count completeness check; the
					// envelope also carries staged columns (T3.3) and the silent
					// over-match warning (T1.3), both built in buildStagedEnvelope.
					const upstreamTotal = inferUpstreamTotal(result.data);
					const staged = await stageToDoAndRespond(
						result.data,
						doNamespace as Parameters<typeof stageToDoAndRespond>[1],
						stagingPrefix,
						undefined,
						undefined,
						stagingPrefix,
						ctx?.sessionId,
						buildStageOptions(
							ctx,
							workspaceNamespace,
							stagingPrefix,
							upstreamTotal,
						),
					);
					return buildStagedEnvelope({
						staged,
						responseBytes,
						originalData: result.data,
					});
				}
				// #3 — an UNSTAGED inline body over the transport limit is silently dropped; fail loud.
				if (responseBytes > TRANSPORT_LIMIT) {
					return { __api_error: true, incomplete: true, status: 413, code: "RESPONSE_TOO_LARGE", message: `Response too large (${responseBytes} > ${TRANSPORT_LIMIT}); narrow the query (fewer fields/rows) or use a paged endpoint.` };
				}

				return result.data;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = (err as { status?: number }).status || 500;
				const driftHint = buildDriftHint(method, interpolatedPath, status, knownEndpoints);
				// incomplete: a failed fetch (429/timeout/5xx/…) means the evidence for
				// this call is INCOMPLETE — flag it so a partial answer is not read as whole.
				return { __api_error: true, incomplete: true, status, message, data: boundedErrorData((err as { data?: unknown }).data), ...(driftHint ? { drift_hint: driftHint } : {}) };
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
	/** WorkspaceDO namespace — when set and `ctx.workspace` is present, staging routes there (ADR-006 Phase 0). */
	workspaceNamespace?: unknown;
}

/**
 * Create the hidden __stage_proxy tool entry.
 * Stages arbitrary data from isolate db.stage() into the server's Durable Object.
 *
 * Accepts optional schema_hints from isolate code to control column types,
 * indexes, and other schema inference parameters. These are forwarded to the
 * DO's /process handler and merged with any server-side hints.
 */
export function createStageProxyTool(
	options: StageProxyToolOptions,
): ToolEntry {
	const { doNamespace, stagingPrefix, workspaceNamespace } = options;

	return {
		name: "__stage_proxy",
		description:
			"Stage arbitrary data from V8 isolate into DO SQLite. Internal only.",
		hidden: true,
		schema: {
			data: z.unknown(),
			table_name: z.string().optional(),
			schema_hints: z
				.object({
					tableName: z.string().optional(),
					columnTypes: z.record(z.string(), z.string()).optional(),
					indexes: z.array(z.string()).optional(),
					exclude: z.array(z.string()).optional(),
					skipChildTables: z.array(z.string()).optional(),
					maxRecursionDepth: z.number().optional(),
					compositeIndexes: z.array(z.array(z.string())).optional(),
				})
				.optional(),
		},
		handler: async (input, ctx) => {
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
					ctx?.sessionId,
					buildStageOptions(ctx, workspaceNamespace, stagingPrefix),
				);

				return {
					data_access_id: staged.dataAccessId,
					tables_created: staged.tablesCreated,
					total_rows: staged.totalRows,
					schema: staged.schema,
					_staging: staged._staging,
					...(staged.stagingWarnings
						? { staging_warnings: staged.stagingWarnings }
						: {}),
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
	/** Workspace DO namespace — when ctx.workspace is set, api.query routes here
	 * (the staged data lives in the shared per-workspace SQLite, ADR-006). */
	workspaceNamespace?: unknown;
}

/**
 * Route an in-isolate query to the WorkspaceDO (`/ws/query`) when a workspace is
 * active — the staged data lives in the shared per-workspace SQLite, addressed by
 * the prefixed table names in the SQL, not a per-server data_access_id — else to
 * the per-server DO via queryDataFromDo. (Inlines the /ws/query POST rather than
 * importing queryWorkspaceFromDo to keep this module's import graph flat.)
 */
/** Page size the in-isolate query proxy requests (bounded by clampLimit). */
const PROXY_QUERY_LIMIT = 1000;

async function runProxyQuery(
	doNamespace: unknown,
	workspaceNamespace: unknown,
	ctx: ToolContext | undefined,
	dataAccessId: string,
	sql: string,
): Promise<{
	rows: unknown[];
	row_count: number;
	sql: string;
	data_access_id: string;
	truncated?: boolean;
	total_matching?: number;
}> {
	const workspace = (ctx as ToolContext | undefined)?.workspace;
	// doc 03 §1 — the in-isolate proxy's page size, clamped to the hard ceiling
	// like every other caller rather than trusted as a bare constant.
	const limit = clampLimit(PROXY_QUERY_LIMIT);
	if (!workspace || !workspaceNamespace) {
		return queryDataFromDo(
			doNamespace as DurableObjectNamespace,
			dataAccessId,
			sql,
			limit,
		);
	}
	const ns = workspaceNamespace as DurableObjectNamespace;
	const stub = ns.get(ns.idFromName(`ws:${workspace}`));
	const resp = await stub.fetch(
		new Request("http://do.internal/ws/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql, limit }),
		}),
	);
	const r = (await resp.json()) as {
		success?: boolean;
		error?: string;
		rows?: unknown[];
		row_count?: number;
		sql?: string;
		truncated?: boolean;
	};
	if (!r.success) {
		throw new Error(`Workspace query failed: ${r.error || "Unknown error"}`);
	}
	return {
		rows: r.rows ?? [],
		row_count: r.row_count ?? 0,
		truncated: r.truncated,
		sql: r.sql ?? sql,
		data_access_id: `ws:${workspace}`,
	};
}

/**
 * Create the hidden __query_proxy tool entry.
 * Routes SQL queries from isolate api.query()/db.queryStaged() to the staged-data
 * DO — per-server via queryDataFromDo, or the shared WorkspaceDO when the call's
 * ToolContext carries an active `workspace` (see runProxyQuery).
 */
export function createQueryProxyTool(
	options: QueryProxyToolOptions,
): ToolEntry {
	const { doNamespace, workspaceNamespace } = options;

	return {
		name: "__query_proxy",
		description:
			"Route SQL queries from V8 isolate to staged data DO. Internal only.",
		hidden: true,
		schema: {
			data_access_id: z.string(),
			sql: z.string(),
		},
		handler: async (input, ctx) => {
			const dataAccessId = String(input.data_access_id || "");
			const sql = String(input.sql || "");

			if (!dataAccessId) {
				return { __query_error: true, message: "data_access_id is required" };
			}
			if (!sql) {
				return { __query_error: true, message: "sql is required" };
			}

			try {
				const result = await runProxyQuery(
					doNamespace,
					workspaceNamespace,
					ctx as ToolContext | undefined,
					dataAccessId,
					sql,
				);
				const queryResult = result as Record<string, unknown>;
				return {
					rows: result.rows,
					row_count: result.row_count,
					...(queryResult.truncated !== undefined
						? { truncated: queryResult.truncated }
						: {}),
					...(queryResult.total_matching !== undefined
						? { total_matching: queryResult.total_matching }
						: {}),
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
