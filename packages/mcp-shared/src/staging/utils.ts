/**
 * Staging utilities — decision logic, DO interaction, data access ID generation.
 */

import {
	createCodeModeResponse,
	createCodeModeError,
	type CodeModeResponse,
	type SuccessResponse,
	type ErrorResponse,
} from "../codemode/response";
import type { SchemaHints } from "./schema-inference";
import { buildStagingMetadata, type StagingMetadata, type TableRelationship } from "./staging-metadata";

const DEFAULT_STAGING_THRESHOLD = 30 * 1024; // 30KB — stage larger responses into SQLite for compact schema summaries

// ---------------------------------------------------------------------------
// DO response interfaces — describe the shapes returned by DO endpoints
// ---------------------------------------------------------------------------

interface ProcessResponse {
	success?: boolean;
	error?: string;
	tables_created?: string[];
	total_rows?: number;
	input_rows?: number;
	table_row_counts?: Record<string, number>;
	staging_warnings?: Record<string, unknown>;
	relationships?: TableRelationship[];
}

interface SchemaResponse {
	success?: boolean;
	schema?: unknown;
	error?: string;
}

interface QueryResponse {
	success?: boolean;
	results?: unknown[];
	row_count?: number;
	error?: string;
	truncated?: boolean;
	total_matching?: number;
}

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

// ---------------------------------------------------------------------------

/** Safely parse a Response body as JSON with a fallback. */
async function parseJsonResponse<T>(resp: Response, fallback: T): Promise<T> {
	const raw: unknown = await resp.json();
	if (raw === null || typeof raw !== "object") return fallback;
	return raw as T;
}

/** Decide whether a response should be staged based on byte size. */
export function shouldStage(responseBytes: number, threshold?: number): boolean {
	return responseBytes > (threshold ?? DEFAULT_STAGING_THRESHOLD);
}

/** Generate a unique data access ID. */
export function generateDataAccessId(prefix: string): string {
	const ts = Date.now();
	const rand = Math.random().toString(36).substring(2, 15);
	return `${prefix}_${ts}_${rand}`;
}

interface DurableObjectStub {
	fetch(req: Request): Promise<Response>;
}

interface DurableObjectNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): DurableObjectStub;
}

export interface StagingProvenance {
	toolName?: string;
	serverName?: string;
	args?: Record<string, unknown>;
	apiUrl?: string;
}

export interface StageResult {
	dataAccessId: string;
	schema: unknown;
	tablesCreated: string[] | undefined;
	totalRows: number | undefined;
	inputRows: number | undefined;
	stagingWarnings: Record<string, unknown> | undefined;
	/** Universal staging metadata — include as `_staging` in structuredContent */
	_staging: StagingMetadata;
}

/**
 * Stage data to a Durable Object and return a structuredContent response
 * with the data_access_id for subsequent SQL queries.
 *
 * @param schemaHints - Optional schema hints forwarded to the DO's /process handler.
 *   These are merged with server-side hints (client hints take precedence).
 * @param toolPrefix - Tool name prefix for query_data/get_schema tool names (e.g. "ctgov", "faers").
 *   If not provided, falls back to `prefix` (the data access ID prefix).
 * @param sessionId - MCP transport session ID. When provided, registers the staged dataset
 *   in a session-scoped registry so get_schema can list available datasets after context compaction.
 */
export async function stageToDoAndRespond(
	data: unknown,
	doNamespace: DurableObjectNamespace,
	prefix: string,
	schemaHints?: SchemaHints,
	provenance?: StagingProvenance,
	toolPrefix?: string,
	sessionId?: string,
): Promise<StageResult> {
	const dataAccessId = generateDataAccessId(prefix);
	const doId = doNamespace.idFromName(dataAccessId);
	const doInstance = doNamespace.get(doId);

	const payloadBytes = JSON.stringify(data).length;

	const processReq = new Request("http://localhost/process", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			data,
			...(provenance ? { context: provenance } : {}),
			...(schemaHints ? { schema_hints: schemaHints } : {}),
		}),
	});

	const processResp = await doInstance.fetch(processReq);
	const processResult = await parseJsonResponse<ProcessResponse>(processResp, { success: false, error: "Empty response from DO" });

	if (!processResult.success) {
		throw new Error(`Failed to stage data in Durable Object: ${processResult.error || "unknown error"}`);
	}

	// Fetch schema
	const schemaResp = await doInstance.fetch(
		new Request("http://localhost/schema"),
	);
	const schemaResult = await parseJsonResponse<SchemaResponse>(schemaResp, { success: false });

	const tables = processResult.tables_created ?? [];
	const resolvedToolPrefix = toolPrefix ?? prefix;
	const primaryTable = tables[0];
	const primaryTableRows = processResult.table_row_counts
		? (primaryTable ? (processResult.table_row_counts[primaryTable] ?? 0) : undefined)
		: undefined;

	// Register in session registry if sessionId is available
	if (sessionId) {
		try {
			const registryId = doNamespace.idFromName("__registry__");
			const registryDo = doNamespace.get(registryId);
			await registryDo.fetch(
				new Request("http://localhost/register", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						session_id: sessionId,
						data_access_id: dataAccessId,
						tool_name: provenance?.toolName,
						tables,
						total_rows: processResult.total_rows,
						tool_prefix: resolvedToolPrefix,
					}),
				}),
			);
		} catch {
			// Non-critical — don't fail staging if registry write fails
		}
	}

	return {
		dataAccessId,
		schema: schemaResult.success ? schemaResult.schema : null,
		tablesCreated: processResult.tables_created,
		totalRows: processResult.total_rows,
		inputRows: processResult.input_rows,
		stagingWarnings: processResult.staging_warnings,
		_staging: buildStagingMetadata({
			dataAccessId,
			tables,
			primaryTable,
			totalRows: processResult.total_rows,
			primaryTableRows,
			tableRowCounts: processResult.table_row_counts,
			payloadSizeBytes: payloadBytes,
			toolPrefix: resolvedToolPrefix,
			relationships: processResult.relationships,
		}),
	};
}

/**
 * Query staged data from a Durable Object with SQL safety checks.
 */
export async function queryDataFromDo(
	doNamespace: DurableObjectNamespace,
	dataAccessId: string,
	sql: string,
	limit = 100,
): Promise<{
	rows: unknown[];
	row_count: number;
	truncated?: boolean;
	total_matching?: number;
	sql: string;
	data_access_id: string;
	executed_at: string;
}> {
	// SQL safety validation
	const sanitizedSql = sql.replace(/--.*$/gm, "").trim();

	if (/\/\*/.test(sanitizedSql)) {
		throw new Error("C-style /* */ comments are not allowed");
	}
	if (sanitizedSql.split(";").filter(Boolean).length > 1) {
		throw new Error("Only single SQL statements are allowed");
	}

	const dangerousKeywords = [
		"DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE",
		"TRUNCATE", "REPLACE", "EXEC", "EXECUTE", "PRAGMA",
		"ATTACH", "DETACH", "REINDEX", "VACUUM", "ANALYZE",
	];
	const upperSql = sanitizedSql.toUpperCase();
	for (const keyword of dangerousKeywords) {
		// Use word-boundary regex to avoid false positives on column names
		// like "created_at" matching CREATE, "updated_at" matching UPDATE, etc.
		const regex = new RegExp(`\\b${keyword}\\b`);
		if (regex.test(upperSql)) {
			throw new Error(
				`SQL command '${keyword}' is not allowed. Only SELECT queries are permitted.`,
			);
		}
	}

	if (!/^\s*(SELECT|WITH)\b/i.test(sanitizedSql)) {
		throw new Error("Only SELECT/WITH queries are allowed");
	}

	let finalSql = sanitizedSql;
	if (!sanitizedSql.toLowerCase().includes("limit")) {
		finalSql += ` LIMIT ${limit}`;
	}

	const doId = doNamespace.idFromName(dataAccessId);
	const doInstance = doNamespace.get(doId);

	const response = await doInstance.fetch(
		new Request("http://localhost/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql: finalSql, count_total: true }),
		}),
	);

	const result = await parseJsonResponse<QueryResponse>(response, { success: false, error: "Empty response from DO" });

	if (!result.success) {
		throw new Error(`Query failed: ${result.error || "Unknown error"}`);
	}

	return {
		rows: result.results ?? [],
		row_count: result.row_count ?? (result.results?.length ?? 0),
		...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
		...(result.total_matching !== undefined ? { total_matching: result.total_matching } : {}),
		sql: finalSql,
		data_access_id: dataAccessId,
		executed_at: new Date().toISOString(),
	};
}

/**
 * Get schema metadata from a Durable Object.
 */
export async function getSchemaFromDo(
	doNamespace: DurableObjectNamespace,
	dataAccessId: string,
): Promise<{
	data_access_id: string;
	schema: unknown;
	retrieved_at: string;
}> {
	const doId = doNamespace.idFromName(dataAccessId);
	const doInstance = doNamespace.get(doId);

	const response = await doInstance.fetch(
		new Request("http://localhost/schema"),
	);
	const result = await parseJsonResponse<SchemaResponse>(response, { success: false, error: "Empty response from DO" });

	if (!result.success) {
		throw new Error(`Schema retrieval failed: ${result.error}`);
	}

	const schema = result.schema;
	if (
		!schema ||
		typeof schema !== "object" ||
		!("tables" in schema) ||
		Object.keys((schema as { tables: object }).tables).length === 0
	) {
		throw new Error(
			`Data access ID "${dataAccessId}" not found or contains no data.`,
		);
	}

	return {
		data_access_id: dataAccessId,
		schema,
		retrieved_at: new Date().toISOString(),
	};
}

/**
 * Standard query_data tool handler. Use in registerTool callback.
 */
export function createQueryDataHandler(
	doBindingName: string,
	toolPrefix: string,
): (args: Record<string, unknown>, env: Record<string, unknown>) => Promise<CodeModeResponse<SuccessResponse<unknown>> | CodeModeResponse<ErrorResponse>> {
	return async (
		args: Record<string, unknown>,
		env: Record<string, unknown>,
	) => {
		const doNamespace = env[doBindingName] as DurableObjectNamespace | undefined;
		if (!doNamespace) {
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${doBindingName} environment not available`,
			);
		}

		try {
			const dataAccessId = String(args.data_access_id || "");
			const sql = String(args.sql || "");
			const limit = Number(args.limit) || 100;

			if (!dataAccessId) throw new Error("data_access_id is required");
			if (!sql) throw new Error("sql is required");

			const result = await queryDataFromDo(doNamespace, dataAccessId, sql, limit);
			const queryResult = result as Record<string, unknown>;
			return createCodeModeResponse(result, {
				meta: {
					data_access_id: result.data_access_id,
					row_count: result.row_count,
					...(queryResult.truncated !== undefined ? { truncated: queryResult.truncated } : {}),
					...(queryResult.total_matching !== undefined ? { total_matching: queryResult.total_matching } : {}),
					executed_at: result.executed_at,
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			let code = "SQL_EXECUTION_ERROR";
			if (msg.includes("not allowed")) code = "INVALID_SQL";
			if (msg.includes("not found") || msg.includes("not available"))
				code = "DATA_ACCESS_ERROR";
			return createCodeModeError(code, `${toolPrefix}_query_data failed: ${msg}`);
		}
	};
}

/**
 * Standard get_schema tool handler. Use in registerTool callback.
 *
 * When `data_access_id` is provided, returns the schema for that specific dataset.
 * When omitted, uses the MCP session to list all staged datasets available in this session.
 */
export function createGetSchemaHandler(
	doBindingName: string,
	toolPrefix: string,
): (args: Record<string, unknown>, env: Record<string, unknown>, sessionId?: string) => Promise<CodeModeResponse<SuccessResponse<unknown>> | CodeModeResponse<ErrorResponse>> {
	return async (
		args: Record<string, unknown>,
		env: Record<string, unknown>,
		sessionId?: string,
	) => {
		const doNamespace = env[doBindingName] as DurableObjectNamespace | undefined;
		if (!doNamespace) {
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${doBindingName} environment not available`,
			);
		}

		const dataAccessId = String(args.data_access_id || "");

		// If data_access_id is provided, return schema for that specific dataset
		if (dataAccessId) {
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

		// No data_access_id — list available staged datasets for this session
		try {
			const registryId = doNamespace.idFromName("__registry__");
			const registryDo = doNamespace.get(registryId);
			const listResp = await registryDo.fetch(
				new Request(`http://localhost/list?session_id=${encodeURIComponent(sessionId || "")}`),
			);
			const listResult = await parseJsonResponse<ListResponse>(listResp, { success: false });

			const datasets = listResult.datasets ?? [];

			if (datasets.length === 0) {
				return createCodeModeResponse(
					{
						staged_datasets: [],
						message: "No staged datasets found for this session. Data may have been staged in a previous session, or no tools have returned large enough responses to trigger staging yet.",
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
					textSummary: `Found ${listing.length} staged dataset(s) in this session:\n${listing.map((d) => `  - ${d.data_access_id} (${d.tool_name || "unknown"}, ${d.total_rows ?? "?"} rows, tables: ${d.tables.join(", ")})`).join("\n")}`,
				},
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${toolPrefix}_get_schema listing failed: ${msg}`,
			);
		}
	};
}
