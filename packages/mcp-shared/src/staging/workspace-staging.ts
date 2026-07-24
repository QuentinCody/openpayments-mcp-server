/**
 * Workspace routing for staging (ADR-006 Phase 0).
 *
 * Cohesive helpers that route a Code Mode server's auto-staging + querying to a
 * shared WorkspaceDO so datasets from different servers land in ONE SQLite and
 * can be JOINed. This is OPT-IN — these helpers only run when a caller threads a
 * `workspace` through `StageOptions` / the `*_query_data` / `*_get_schema`
 * inputs. Absent a workspace, the per-server staging path in `utils.ts` runs
 * unchanged.
 *
 * WorkspaceDO contract (`idFromName("ws:" + workspaceId)`):
 *   POST /ws/stage  {dataset, data, schema_hints?, source_tool?}
 *     → {success, dataset, data_access_id, tables:string[], schema, row_count}
 *   POST /ws/query  {sql, limit?}
 *     → {success, rows, row_count, sql, complete_view:true}
 *   GET  /ws/schema[?dataset=]
 *     → {success, dataset_count, datasets}
 */

import type { SchemaHints } from "./schema-inference";
import { buildStagingMetadata } from "./staging-metadata";
import type { StageResult } from "./utils";
import { workspaceCompleteness } from "./workspace-completeness";

// DO `fetch()` ignores the request URL host — it routes to the addressed
// instance regardless. We use a synthetic internal origin so the path/query is
// well-formed without hardcoding `http://localhost` (which the lint gate blocks).
export const DO_FETCH_ORIGIN = "http://do.internal";

interface DurableObjectStub {
	fetch(req: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): DurableObjectStub;
}

/** Safely parse a Response body as JSON with a fallback. */
async function parseJsonResponse<T>(resp: Response, fallback: T): Promise<T> {
	const raw: unknown = await resp.json();
	if (raw === null || typeof raw !== "object") return fallback;
	return raw as T;
}

/** Shape returned by the WorkspaceDO `/ws/stage` route. */
interface WorkspaceStageResponse {
	success: boolean;
	error?: string;
	data_access_id?: string;
	tables?: string[];
	row_count?: number;
	/** Top-level upstream records staged (parent-table input length, excludes
	 * child/grandchild rows). The pagination denominator — compare to upstreamTotal.
	 * Mirrors `stageDataset`'s `DatasetHandle.primary_row_count`. */
	primary_row_count?: number;
	/** Materialization result from the DO: `complete:false` when some fetched
	 * rows failed to insert. Mirrors `stageDataset`'s `DatasetHandle.completeness`. */
	completeness?: { complete: boolean; failed_rows?: number };
	evidence_table?: string;
	payload_hash?: string;
}

/** Shape returned by the WorkspaceDO `/ws/query` route. */
interface WorkspaceQueryResponse {
	success?: boolean;
	error?: string;
	rows?: unknown[];
	row_count?: number;
	sql?: string;
	complete_view?: true;
}

/** Shape returned by the WorkspaceDO `/ws/schema` route. */
interface WorkspaceSchemaResponse {
	success?: boolean;
	error?: string;
	dataset_count?: number;
	datasets?: unknown[];
}

export interface WorkspaceTarget {
	/** The WorkspaceDO DurableObjectNamespace binding. */
	namespace: unknown;
	/** The workspace id — instance is `idFromName("ws:" + id)`. */
	id: string;
	/** Dataset name to namespace this server's tables under. */
	dataset: string;
}

/**
 * Stage `data` into the shared WorkspaceDO and return a {@link StageResult}
 * mirroring the per-server stage shape (so callers are agnostic to the route).
 * Throws if the workspace reports failure — staging must never silently drop.
 */
export async function stageIntoWorkspace(
	data: unknown,
	workspace: WorkspaceTarget,
	payloadBytes: number,
	toolPrefix: string,
	fallbackDataAccessId: string,
	schemaHints?: SchemaHints,
	sourceTool?: string,
	upstreamTotal?: number,
): Promise<StageResult> {
	const wsNs = workspace.namespace as DurableObjectNamespace;
	const wsInstance = wsNs.get(wsNs.idFromName(`ws:${workspace.id}`));
	const wsResp = await wsInstance.fetch(
		new Request(`${DO_FETCH_ORIGIN}/ws/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				dataset: workspace.dataset,
				data,
				...(schemaHints ? { schema_hints: schemaHints } : {}),
				source_tool: sourceTool,
			}),
		}),
	);
	const wsResult = await parseJsonResponse<WorkspaceStageResponse>(wsResp, {
		success: false,
		error: "Empty workspace response",
	});
	if (!wsResult.success) {
		throw new Error(
			`Failed to stage into workspace: ${wsResult.error || "unknown error"}`,
		);
	}
	const wsTables = wsResult.tables ?? [];
	const wsDataAccessId = wsResult.data_access_id ?? fallbackDataAccessId;
	return {
		dataAccessId: wsDataAccessId,
		schema: null,
		tablesCreated: wsTables,
		totalRows: wsResult.row_count,
		inputRows: wsResult.primary_row_count,
		stagingWarnings: undefined,
		_staging: buildStagingMetadata({
			dataAccessId: wsDataAccessId,
			tables: wsTables,
			primaryTable: wsTables[0],
			totalRows: wsResult.row_count,
			primaryTableRows: wsResult.primary_row_count ?? wsResult.row_count,
			tableRowCounts: undefined,
			payloadSizeBytes: payloadBytes,
			toolPrefix,
			relationships: undefined,
			completeness: workspaceCompleteness(upstreamTotal, wsResult),
			evidenceTable: wsResult.evidence_table,
			payloadHash: wsResult.payload_hash,
		}),
	};
}

/**
 * Query the shared WorkspaceDO (`/ws/query`). The WorkspaceDO applies its own
 * read-only SQL guard, so this is a thin pass-through mirroring the
 * `queryDataFromDo` return shape.
 */
export async function queryWorkspaceFromDo(
	workspaceNamespace: DurableObjectNamespace,
	workspaceId: string,
	sql: string,
	limit = 100,
): Promise<{
	rows: unknown[];
	row_count: number;
	complete_view: true;
	sql: string;
	data_access_id: string;
	executed_at: string;
}> {
	const wsInstance = workspaceNamespace.get(
		workspaceNamespace.idFromName(`ws:${workspaceId}`),
	);
	const response = await wsInstance.fetch(
		new Request(`${DO_FETCH_ORIGIN}/ws/query`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql, limit }),
		}),
	);
	const result = await parseJsonResponse<WorkspaceQueryResponse>(response, {
		success: false,
		error: "Empty response from workspace DO",
	});
	if (!result.success) {
		throw new Error(
			`Workspace query failed: ${result.error || "Unknown error"}`,
		);
	}
	return {
		rows: result.rows ?? [],
		row_count: result.row_count ?? result.rows?.length ?? 0,
		complete_view: true,
		sql: result.sql ?? sql,
		data_access_id: `ws:${workspaceId}`,
		executed_at: new Date().toISOString(),
	};
}

/**
 * Read the cross-dataset catalog from the shared WorkspaceDO (`/ws/schema`,
 * optionally scoped to a single `dataset`).
 */
export async function getWorkspaceSchemaFromDo(
	workspaceNamespace: DurableObjectNamespace,
	workspaceId: string,
	dataset?: string,
): Promise<{
	workspace_id: string;
	schema: { dataset_count?: number; datasets?: unknown[] };
	retrieved_at: string;
}> {
	const wsInstance = workspaceNamespace.get(
		workspaceNamespace.idFromName(`ws:${workspaceId}`),
	);
	const query = dataset ? `?dataset=${encodeURIComponent(dataset)}` : "";
	const response = await wsInstance.fetch(
		new Request(`${DO_FETCH_ORIGIN}/ws/schema${query}`),
	);
	const result = await parseJsonResponse<WorkspaceSchemaResponse>(response, {
		success: false,
		error: "Empty response from workspace DO",
	});
	if (result.success === false) {
		throw new Error(
			`Workspace schema retrieval failed: ${result.error || "Unknown error"}`,
		);
	}
	return {
		workspace_id: workspaceId,
		schema: { dataset_count: result.dataset_count, datasets: result.datasets },
		retrieved_at: new Date().toISOString(),
	};
}
