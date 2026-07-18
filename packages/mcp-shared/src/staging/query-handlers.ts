/**
 * Standard `<prefix>_query_data` / `<prefix>_get_schema` tool handlers.
 *
 * Extracted from `staging/utils.ts` (re-exported there for back-compat with the
 * `@bio-mcp/shared/staging/utils` import path used across servers). Each handler
 * has two routes:
 *   1. per-server DO (default, unchanged) — query/list against the server's own
 *      data DO + `__registry__`.
 *   2. shared WorkspaceDO (ADR-006 Phase 0, opt-in) — when a `workspace`
 *      binding is wired AND the tool input carries a `workspace` id, query/schema
 *      route to `/ws/query` / `/ws/schema` so cross-server datasets JOIN in one
 *      SQLite. Absent either, the per-server path runs byte-for-byte unchanged.
 */

import {
	type CodeModeResponse,
	createCodeModeError,
	createCodeModeResponse,
	type ErrorResponse,
	type SuccessResponse,
} from "../codemode/response";
import type { Completeness } from "../completeness";
import { getRequestScope, type MaybeExtra } from "../registry/request-scope";
import { enrichStagedQueryError } from "./query-error-hint";
import { clampLimit } from "./sql-guard";
import { getSchemaFromDo, queryDataFromDo } from "./utils";
import {
	type DurableObjectNamespace,
	getWorkspaceSchemaFromDo,
	queryWorkspaceFromDo,
} from "./workspace-staging";

type HandlerResponse =
	| CodeModeResponse<SuccessResponse<unknown>>
	| CodeModeResponse<ErrorResponse>;

interface ListDataset {
	data_access_id: string;
	tool_name: string | null;
	tables: string[];
	total_rows: number | null;
	tool_prefix: string | null;
	created_at: string;
}

interface ListResponse {
	success?: boolean;
	datasets?: ListDataset[];
}

/** Optional handler wiring shared by query_data / get_schema tool handlers. */
export interface DataHandlerOptions {
	/** WorkspaceDO namespace — enables `workspace`-routed query/schema (ADR-006 Phase 0). */
	workspaceNamespace?: unknown;
}

const DO_FETCH_ORIGIN = "http://do.internal";

/** Safely parse a Response body as JSON with a fallback. */
async function parseJsonResponse<T>(resp: Response, fallback: T): Promise<T> {
	const raw: unknown = await resp.json();
	if (raw === null || typeof raw !== "object") return fallback;
	return raw as T;
}

/** Read the `workspace` routing intent (id + namespace) shared by both handlers. */
function resolveWorkspaceRoute(
	args: Record<string, unknown>,
	handlerOptions?: DataHandlerOptions,
): { id: string; namespace: DurableObjectNamespace } | undefined {
	const id = args.workspace ? String(args.workspace) : "";
	const namespace = handlerOptions?.workspaceNamespace as
		| DurableObjectNamespace
		| undefined;
	return id && namespace ? { id, namespace } : undefined;
}

/** Map a query error message to its CodeMode error code (per-server path). */
function queryErrorCode(msg: string, err: unknown): string {
	// The DO stamps a code on cost/guard rejections (doc 03) — trust it over the
	// message text.
	const code = (err as { code?: unknown })?.code;
	if (code === "QUERY_COST_LIMIT" || code === "WRITE_SQL_BLOCKED") return code;
	if (msg.includes("not allowed")) return "INVALID_SQL";
	if (msg.includes("not found") || msg.includes("not available"))
		return "DATA_ACCESS_ERROR";
	if (err instanceof Error && "validated" in err) return "SQL_VALIDATION_ERROR";
	return "SQL_EXECUTION_ERROR";
}

/** Build the canonical completeness verdict from per-server query truncation signals. */
function queryCompleteness(
	result: {
		truncated?: boolean;
		total_matching?: number;
		count_capped?: boolean;
		truncation?: { reason: string; detail: string };
		row_count: number;
	},
	limit: number,
): Completeness | undefined {
	if (result.truncated === true) {
		const total = result.count_capped
			? `at least ${result.total_matching}`
			: (result.total_matching ?? "more");
		return {
			complete: false,
			...(result.total_matching != null
				? { total_available: result.total_matching }
				: {}),
			returned: result.row_count,
			truncation: {
				// The DO reports WHY it stopped (row ceiling vs byte ceiling); fall
				// back to the LIMIT explanation when it did not truncate the pull.
				reason:
					result.truncation?.reason === "size_limit"
						? "size_limit"
						: "row_limit",
				detail:
					result.truncation?.detail ??
					`Query matched ${total} row(s) but only ${result.row_count} were returned (LIMIT ${limit}).`,
				remedy:
					"Raise the limit param, add WHERE filters, or aggregate in SQL to see the full picture.",
			},
		};
	}
	if (result.truncated === false) {
		return {
			complete: true,
			...(result.total_matching != null
				? { total_available: result.total_matching }
				: {}),
			returned: result.row_count,
		};
	}
	return undefined;
}

/** Workspace-routed `*_query_data` — POSTs SQL to `/ws/query`. */
async function workspaceQuery(
	route: { id: string; namespace: DurableObjectNamespace },
	args: Record<string, unknown>,
	toolPrefix: string,
): Promise<HandlerResponse> {
	try {
		const sql = String(args.sql || "");
		const limit = clampLimit(Number(args.limit) || 100);
		if (!sql) throw new Error("sql is required");
		const result = await queryWorkspaceFromDo(
			route.namespace,
			route.id,
			sql,
			limit,
		);
		return createCodeModeResponse(result, {
			meta: {
				workspace: route.id,
				row_count: result.row_count,
				...(result.truncated !== undefined
					? { truncated: result.truncated }
					: {}),
				executed_at: result.executed_at,
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const detail = await enrichStagedQueryError(msg, () =>
			getWorkspaceSchemaFromDo(route.namespace, route.id),
		);
		return createCodeModeError(
			"SQL_EXECUTION_ERROR",
			`${toolPrefix}_query_data failed: ${detail}`,
		);
	}
}

/** Per-server `*_query_data` — queries the server's own data DO. */
async function perServerQuery(
	doNamespace: DurableObjectNamespace,
	args: Record<string, unknown>,
	toolPrefix: string,
): Promise<HandlerResponse> {
	try {
		const dataAccessId = String(args.data_access_id || "");
		const sql = String(args.sql || "");
		const limit = clampLimit(Number(args.limit) || 100);
		if (!dataAccessId) throw new Error("data_access_id is required");
		if (!sql) throw new Error("sql is required");

		const result = await queryDataFromDo(doNamespace, dataAccessId, sql, limit);
		const queryResult = result as Record<string, unknown>;
		const completeness = queryCompleteness(result, limit);

		return createCodeModeResponse(result, {
			meta: {
				data_access_id: result.data_access_id,
				row_count: result.row_count,
				...(queryResult.truncated !== undefined
					? { truncated: queryResult.truncated }
					: {}),
				...(queryResult.total_matching !== undefined
					? { total_matching: queryResult.total_matching }
					: {}),
				...(completeness ? { completeness } : {}),
				executed_at: result.executed_at,
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Self-describing errors: on "no such column/table", append the staged
		// schema so the model fixes its SQL in one step (the DO has it locally).
		const detail = await enrichStagedQueryError(msg, () =>
			getSchemaFromDo(doNamespace, String(args.data_access_id || "")),
		);
		return createCodeModeError(
			queryErrorCode(msg, err),
			`${toolPrefix}_query_data failed: ${detail}`,
		);
	}
}

/**
 * Standard query_data tool handler. Use in registerTool callback.
 *
 * When a `workspaceNamespace` binding is supplied AND the tool input carries a
 * `workspace` id, the query is routed to the shared WorkspaceDO (`/ws/query`)
 * instead of the per-server DO. Otherwise behavior is unchanged.
 */
export function createQueryDataHandler(
	doBindingName: string,
	toolPrefix: string,
	handlerOptions?: DataHandlerOptions,
): (
	args: Record<string, unknown>,
	env: Record<string, unknown>,
) => Promise<HandlerResponse> {
	return async (args, env) => {
		const route = resolveWorkspaceRoute(args, handlerOptions);
		if (route) return workspaceQuery(route, args, toolPrefix);

		const doNamespace = env[doBindingName] as
			| DurableObjectNamespace
			| undefined;
		if (!doNamespace) {
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${doBindingName} environment not available`,
			);
		}
		return perServerQuery(doNamespace, args, toolPrefix);
	};
}

/** Workspace-routed `*_get_schema` — reads `/ws/schema`. */
async function workspaceSchema(
	route: { id: string; namespace: DurableObjectNamespace },
	args: Record<string, unknown>,
	toolPrefix: string,
): Promise<HandlerResponse> {
	try {
		const dataset = args.dataset ? String(args.dataset) : undefined;
		const result = await getWorkspaceSchemaFromDo(
			route.namespace,
			route.id,
			dataset,
		);
		return createCodeModeResponse(result, {
			textSummary: JSON.stringify(result),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return createCodeModeError(
			"DATA_ACCESS_ERROR",
			`${toolPrefix}_get_schema failed: ${msg}`,
		);
	}
}

/** Per-server `*_get_schema` for a specific data_access_id. */
async function perServerSchema(
	doNamespace: DurableObjectNamespace,
	dataAccessId: string,
	toolPrefix: string,
): Promise<HandlerResponse> {
	try {
		const result = await getSchemaFromDo(doNamespace, dataAccessId);
		return createCodeModeResponse(result, {
			textSummary: JSON.stringify(result),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return createCodeModeError(
			"DATA_ACCESS_ERROR",
			`${toolPrefix}_get_schema failed: ${msg}`,
		);
	}
}

/** Per-server `*_get_schema` with no id — list datasets registered for the scope. */
async function listStagedDatasets(
	doNamespace: DurableObjectNamespace,
	toolPrefix: string,
	scope?: string | MaybeExtra,
): Promise<HandlerResponse> {
	const resolvedScope = getRequestScope(scope);
	try {
		// Must mirror registerStagedDataset's scoping exactly, or listing reads a
		// different DO than registration wrote to.
		const registryDo = doNamespace.get(
			doNamespace.idFromName(
				resolvedScope ? `${resolvedScope}:__registry__` : "__registry__",
			),
		);
		const listResp = await registryDo.fetch(
			new Request(
				`${DO_FETCH_ORIGIN}/list?session_id=${encodeURIComponent(resolvedScope || "")}`,
			),
		);
		const listResult = await parseJsonResponse<ListResponse>(listResp, {
			success: false,
		});
		const datasets = listResult.datasets ?? [];

		if (datasets.length === 0) {
			return createCodeModeResponse(
				{
					staged_datasets: [],
					message: "No staged datasets found for this session.",
				},
				{ textSummary: "No staged datasets found for this session." },
			);
		}

		const listing = datasets.map((d) => ({
			data_access_id: d.data_access_id,
			tool_name: d.tool_name,
			tables: d.tables,
			total_rows: d.total_rows,
			query_tool: `${d.tool_prefix || toolPrefix}_query_data`,
			schema_tool: `${d.tool_prefix || toolPrefix}_get_schema`,
			created_at: d.created_at,
		}));
		return createCodeModeResponse(
			{
				staged_datasets: listing,
				hint: "Call this tool with a specific data_access_id to get the full schema for that dataset.",
			},
			{
				textSummary: `Found ${listing.length} staged dataset(s) in this session.`,
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return createCodeModeError(
			"DATA_ACCESS_ERROR",
			`${toolPrefix}_get_schema listing failed: ${msg}`,
		);
	}
}

/**
 * Standard get_schema tool handler. Use in registerTool callback.
 *
 * When `data_access_id` is provided, returns the schema for that specific dataset.
 * When omitted, lists all staged datasets registered against the caller's scope.
 * When a `workspaceNamespace` binding is supplied AND the tool input carries a
 * `workspace` id, the schema is read from the shared WorkspaceDO (`/ws/schema`).
 * Otherwise behavior is unchanged. The 3rd argument accepts the tool handler's
 * `extra` object (preferred) or a plain string (legacy MCP transport sessionId).
 */
export function createGetSchemaHandler(
	doBindingName: string,
	toolPrefix: string,
	handlerOptions?: DataHandlerOptions,
): (
	args: Record<string, unknown>,
	env: Record<string, unknown>,
	scope?: string | MaybeExtra,
) => Promise<HandlerResponse> {
	return async (args, env, scope) => {
		const route = resolveWorkspaceRoute(args, handlerOptions);
		if (route) return workspaceSchema(route, args, toolPrefix);

		const doNamespace = env[doBindingName] as
			| DurableObjectNamespace
			| undefined;
		if (!doNamespace) {
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${doBindingName} environment not available`,
			);
		}

		const dataAccessId = String(args.data_access_id || "");
		if (dataAccessId)
			return perServerSchema(doNamespace, dataAccessId, toolPrefix);
		return listStagedDatasets(doNamespace, toolPrefix, scope);
	};
}
