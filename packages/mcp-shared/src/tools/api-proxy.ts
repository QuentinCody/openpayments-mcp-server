/**
 * Hidden __api_proxy tool — routes V8 isolate api.get/api.post calls
 * through the server's HTTP fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It validates paths, delegates to the server's ApiFetchFn, and
 * auto-stages large responses via stageToDoAndRespond().
 */

import { z } from "zod";
import { adapterFailureMessage, type ApiFetchFn } from "../codemode/catalog";
import type { ApiProxyToolOptions } from "./api-proxy-options";
export type { ApiProxyToolOptions } from "./api-proxy-options";
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
	detectUndeclaredParams,
	buildKnownEndpointIndex,
	preflightUnknownEndpoint,
} from "./api-proxy-drift";
import {
	boundedErrorData,
	jsonByteSize,
	TRANSPORT_LIMIT,
} from "./passthrough-limits";
import { buildStagedEnvelope, extractStagedColumns, resolveUpstreamTotal } from "./staging-envelope";

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
	// A URL parser reads `%2e` as a dot and `\` as a slash. So `/.%2e/`, `/%2e./`
	// and `\..\` are traversal too: `new URL("/.%2e/.%2e/other", base)` leaves the
	// API root and reaches another service on the same host, with this server's
	// credentials. Check the path as written and as the parser reads it.
	const asParsed = path.replace(/%2e/gi, ".").replace(/%5c/gi, "\\").replace(/\\/g, "/");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(path) || pattern.test(asParsed)) {
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

async function preserveApiErrorData(
	data: unknown,
	options: {
		doNamespace?: unknown;
		stagingPrefix?: string;
		stagingThreshold?: number;
		workspaceNamespace?: unknown;
		ctx?: ToolContext;
	},
): Promise<unknown> {
	if (data === undefined) return undefined;
	const responseBytes = jsonByteSize(data);
	if (
		options.doNamespace &&
		options.stagingPrefix &&
		shouldStage(responseBytes, options.stagingThreshold)
	) {
		const staged = await stageToDoAndRespond(
			data,
			options.doNamespace as Parameters<typeof stageToDoAndRespond>[1],
			options.stagingPrefix,
			undefined,
			undefined,
			options.stagingPrefix,
			options.ctx?.sessionId,
			buildStageOptions(
				options.ctx,
				options.workspaceNamespace,
				options.stagingPrefix,
			),
		);
		return buildStagedEnvelope({ staged, responseBytes, originalData: data });
	}
	return boundedErrorData(data);
}

/**
 * The `licenseProfile` field of an ApiFetchFn request, from the tool context. It lets the
 * adapter withhold content that a reselling caller may not receive (see catalog.ts).
 */
export function licenseProfileField(ctx: ToolContext | undefined): { licenseProfile?: "commercial" } {
	const licenseProfile = ctx?.requestContext?.licenseProfile;
	return licenseProfile ? { licenseProfile } : {};
}

/** The local 404 for a path that no known endpoint matches (pre-flight drift check). */
function unknownEndpointError(
	method: string,
	path: string,
	preflight: NonNullable<ReturnType<typeof preflightUnknownEndpoint>>,
): Record<string, unknown> {
	return {
		__api_error: true,
		status: 404,
		code: "UNKNOWN_ENDPOINT",
		attempted: `${method} ${path}`,
		message: preflight.message,
		...(preflight.suggestions?.[0] ? { closest_match: preflight.suggestions[0] } : {}),
		drift_hint: preflight,
		preflight: true,
	};
}

/** The 413 for an unstaged inline body above the transport limit (it would be dropped). */
function tooLargeError(responseBytes: number): Record<string, unknown> {
	return {
		__api_error: true,
		incomplete: true,
		status: 413,
		code: "RESPONSE_TOO_LARGE",
		message: `Response too large (${responseBytes} bytes); staging is required. Narrow the query (fewer fields/rows) or use a paged endpoint.`,
	};
}

/**
 * The error object of a failed upstream call (a throw, or a resolved non-2xx).
 * `incomplete` marks the evidence of this call as partial (429/timeout/5xx/…), so a
 * partial answer is not read as whole. A large error body is staged, not dropped.
 */
async function apiFailure(
	status: number,
	message: string,
	data: unknown,
	driftHint: unknown,
	options: ApiProxyToolOptions,
	ctx: ToolContext,
): Promise<Record<string, unknown>> {
	const errorData = await preserveApiErrorData(data, { ...options, ctx });
	return { __api_error: true, incomplete: true, status, message, data: errorData, ...(driftHint ? { drift_hint: driftHint } : {}) };
}

/**
 * Stage a large upstream result and return the staged envelope. `upstreamTotal`
 * powers the under-count completeness check; the envelope also carries staged
 * columns (T3.3) and the silent over-match warning (T1.3), built in buildStagedEnvelope.
 */
async function stageResult(
	result: Awaited<ReturnType<ApiFetchFn>>,
	responseBytes: number,
	target: { doNamespace: unknown; stagingPrefix: string; workspaceNamespace?: unknown },
	ctx: ToolContext,
): Promise<unknown> {
	const upstreamTotal = resolveUpstreamTotal(result.data, result.upstreamTotal);
	const staged = await stageToDoAndRespond(
		result.data,
		target.doNamespace as Parameters<typeof stageToDoAndRespond>[1],
		target.stagingPrefix,
		undefined,
		undefined,
		target.stagingPrefix,
		ctx?.sessionId,
		buildStageOptions(ctx, target.workspaceNamespace, target.stagingPrefix, upstreamTotal),
	);
	return buildStagedEnvelope({ staged, responseBytes, originalData: result.data, completeness: result.completeness });
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
		maxInlineBytes,
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
				const preflight = preflightUnknownEndpoint(method, path, knownEndpoints);
				if (preflight) return unknownEndpointError(method, path, preflight);

				const result = await apiFetch({
					method,
					path,
					params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
					body,
					...licenseProfileField(ctx),
				});

				// A resolved non-2xx is a FAILURE (the catch only fires on THROW) — an
				// adapter that RETURNS {status:502,data} else surfaces it as data with a
				// citation, the systemic clingen-class silent failure (doc 09/11).
				if (typeof result.status === "number" && result.status >= 400) {
					const driftHint = buildDriftHint(method, path, result.status, knownEndpoints);
					const message = adapterFailureMessage(result.status, result.data);
					return await apiFailure(result.status, message, result.data, driftHint, options, ctx);
				}

				// T10.1 — a SINGLE record gets a raised staging threshold so it stays
				// inline. undefined data (a 204 no-content) sizes to 0, not a throw (#7).
				const responseBytes = result.data === undefined ? 0 : jsonByteSize(result.data);
				if (
					doNamespace &&
					stagingPrefix &&
					shouldStage(
						responseBytes,
						Math.min(effectiveStagingThreshold(result.data, stagingThreshold), maxInlineBytes ?? Infinity),
					)
				) {
					return await stageResult(result, responseBytes, { doNamespace, stagingPrefix, workspaceNamespace }, ctx);
				}
				// #3 — an UNSTAGED inline body over the transport limit is silently dropped; fail loud.
				if (responseBytes > Math.min(TRANSPORT_LIMIT, maxInlineBytes ?? Infinity)) {
					return tooLargeError(responseBytes);
				}

				// A 200 is not proof the filter was applied — see detectUndeclaredParams.
				const undeclared = detectUndeclaredParams(method, interpolatedPath, rawParams, knownEndpoints);
				return undeclared && isRecord(result.data)
					? { ...result.data, __unfiltered_warning: undeclared }
					: result.data;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = (err as { status?: number }).status || 500;
				const driftHint = buildDriftHint(method, interpolatedPath, status, knownEndpoints);
				return apiFailure(status, message, (err as { data?: unknown }).data, driftHint, options, ctx);
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
