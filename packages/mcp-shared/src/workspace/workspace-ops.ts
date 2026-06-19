/**
 * Workspace data-plane operations (ADR-006 Phase 0).
 *
 * A *workspace* is one Durable Object — one SQLite database — that holds every
 * dataset staged during a workflow, each in tables namespaced by its dataset
 * name (`chembl__targets`, `dgidb__targets`, ...). Because every dataset lands
 * in the *same* SQLite, an agent can JOIN across servers in one SELECT — the
 * thing per-server staging cannot do.
 *
 * These ops are pure functions over a SQL interface so they unit-test against
 * an in-memory SQLite. `WorkspaceDO` is the thin Durable Object that calls them
 * with `this.ctx.storage.sql`.
 */
import { applyDefaultLimit, assertReadOnlySql } from "../staging/sql-guard";
import {
	detectArrays,
	type InferredSchema,
	inferSchema,
	materializeSchema,
	type SchemaHints,
} from "../staging/schema-inference";

/** The subset of Cloudflare's `SqlStorage` these ops use. */
export interface WorkspaceSql {
	exec(query: string, ...bindings: unknown[]): {
		toArray(): Record<string, unknown>[];
		one(): Record<string, unknown> | undefined;
	};
}

const MANIFEST = "_workspace_datasets";

/** Lazily create the per-workspace dataset manifest. Idempotent. */
export function ensureWorkspaceTables(sql: WorkspaceSql): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${MANIFEST} (
			dataset        TEXT PRIMARY KEY,
			data_access_id TEXT NOT NULL,
			source_tool    TEXT,
			tables_json    TEXT NOT NULL,
			schema_json    TEXT,
			row_count      INTEGER NOT NULL,
			completeness   TEXT,
			created_at     TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
	);
}

/** Tolerant parse of a manifest JSON column; null on missing/invalid. */
function tryParseJson(value: unknown): unknown {
	if (typeof value !== "string") return null;
	try {
		return JSON.parse(value);
	} catch (err) {
		// Corrupt JSON in a manifest column — treat as absent rather than throw.
		void err;
		return null;
	}
}

/** A manifest `tables_json` column → a clean string[] (empty if missing/corrupt). */
function parseTableList(value: unknown): string[] {
	const parsed = tryParseJson(value);
	return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

/** Same sanitizer handleProcess uses to turn an array key into a table name. */
function sanitizeArrayKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

/** A friendly dataset handle must be a safe SQL identifier fragment. */
function sanitizeDataset(name: string): string {
	const s = name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().replace(/^_+/, "");
	if (!s) throw new Error(`Invalid dataset name: "${name}"`);
	return s;
}

/**
 * Prefix every table name (and child-table FK parent ref) with `dataset__`, so
 * two datasets' tables coexist in one SQLite without collision and JOIN cleanly.
 */
export function prefixSchema(schema: InferredSchema, dataset: string): InferredSchema {
	return {
		tables: schema.tables.map((t) => ({
			...t,
			name: `${dataset}__${t.name}`,
			...(t.childOf
				? { childOf: { ...t.childOf, parentTable: `${dataset}__${t.childOf.parentTable}` } }
				: {}),
		})),
	};
}

export interface StageDatasetParams {
	dataset: string;
	data: unknown;
	schemaHints?: SchemaHints;
	sourceTool?: string;
}

export interface DatasetHandle {
	dataset: string;
	data_access_id: string;
	tables: string[];
	schema: InferredSchema | null;
	row_count: number;
	/** Top-level upstream records staged (parent-table input length), EXCLUDING
	 * child/grandchild rows. The denominator for the upstream-pagination check
	 * (row_count would over-count for nested payloads and mask a partial page). */
	primary_row_count: number;
	completeness: { complete: boolean; failed_rows?: number };
}

function newDataAccessId(dataset: string): string {
	// Runs in the DO / node runtime (not a workflow script), so Date/Math are OK.
	return `${dataset}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Drop a dataset's previously-staged tables and forget its manifest row. */
function dropDatasetTables(sql: WorkspaceSql, dataset: string): void {
	// Cloudflare's SqlStorage.one() THROWS on zero rows (a forgiving test stub does
	// not) — and this manifest lookup is empty on a dataset's first stage. Read via
	// toArray() so the real workerd runtime doesn't error. (Caught by the live
	// wrangler-dev JOIN test; the node:sqlite unit adapter masked it.)
	const row = sql
		.exec(`SELECT tables_json FROM ${MANIFEST} WHERE dataset = ?`, dataset)
		.toArray()[0] as { tables_json?: string } | undefined;
	for (const t of parseTableList(row?.tables_json)) {
		sql.exec(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
	}
	sql.exec(`DELETE FROM ${MANIFEST} WHERE dataset = ?`, dataset);
}

/**
 * Materialize `data` into `dataset__*` tables and record it in the manifest.
 * Re-staging the same dataset replaces its prior tables.
 */
export function stageDataset(sql: WorkspaceSql, params: StageDatasetParams): DatasetHandle {
	ensureWorkspaceTables(sql);
	const dataset = sanitizeDataset(params.dataset);
	dropDatasetTables(sql, dataset);

	const arrays = detectArrays(params.data);
	const hasRows = arrays.some((a) => a.rows.length > 0);

	let tables: string[] = [];
	let schema: InferredSchema | null = null;
	let rowCount = 0;
	let primaryRowCount = 0;
	let failedRows = 0;

	if (hasRows) {
		const inferred = inferSchema(arrays, params.schemaHints);
		schema = prefixSchema(inferred, dataset);

		// rowsMap keyed by the *prefixed* parent-table names (mirrors handleProcess).
		const rowsMap = new Map<string, unknown[]>();
		for (const arr of arrays) {
			if (arr.rows.length === 0) continue;
			const baseName = params.schemaHints?.tableName ?? sanitizeArrayKey(arr.key);
			const actualBase = inferred.tables.length === 1
				? inferred.tables[0].name
				: inferred.tables.find((t) => t.name === baseName)?.name ?? baseName;
			rowsMap.set(`${dataset}__${actualBase}`, arr.rows);
		}

		const result = materializeSchema(schema, rowsMap, sql);
		tables = result.tablesCreated;
		rowCount = result.totalRows;
		primaryRowCount = result.inputRows;
		failedRows = result.failedRows;
	} else {
		// No tabular arrays: park the raw payload as a single JSON row, still reachable.
		const table = `${dataset}__payload`;
		sql.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, root_json TEXT)`);
		sql.exec(`INSERT INTO "${table}" (root_json) VALUES (?)`, JSON.stringify(params.data ?? null));
		tables = [table];
		rowCount = 1;
		primaryRowCount = 1;
	}

	const dataAccessId = newDataAccessId(dataset);
	const completeness: DatasetHandle["completeness"] = failedRows > 0
		? { complete: false, failed_rows: failedRows }
		: { complete: true };

	sql.exec(
		`INSERT OR REPLACE INTO ${MANIFEST}
			(dataset, data_access_id, source_tool, tables_json, schema_json, row_count, completeness, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		dataset,
		dataAccessId,
		params.sourceTool ?? null,
		JSON.stringify(tables),
		schema ? JSON.stringify(schema) : null,
		rowCount,
		JSON.stringify(completeness),
	);

	return { dataset, data_access_id: dataAccessId, tables, schema, row_count: rowCount, primary_row_count: primaryRowCount, completeness };
}

export interface QueryWorkspaceResult {
	rows: Record<string, unknown>[];
	row_count: number;
	sql: string;
	/** A full page came back and the caller set no LIMIT → there may be more rows. */
	truncated: boolean;
}

/** The cross-dataset JOIN surface: read-only SQL across every staged table. */
export function queryWorkspace(
	sql: WorkspaceSql,
	params: { sql: string; limit?: number },
): QueryWorkspaceResult {
	const sanitized = assertReadOnlySql(params.sql);
	const limit = params.limit ?? 100;
	const callerSetLimit = sanitized.toLowerCase().includes("limit");
	const finalSql = applyDefaultLimit(sanitized, limit);
	const rows = sql.exec(finalSql).toArray();

	// Heuristic truncation: a full default page, with no caller LIMIT, means the
	// result was capped — signal it so the agent paginates. (Deliberately no
	// COUNT(*) wrapper: it errors on duplicate-column / complex SQL and the exact
	// total isn't needed to decide whether to fetch more.)
	const truncated = !callerSetLimit && rows.length >= limit;

	return { rows, row_count: rows.length, sql: finalSql, truncated };
}

export interface WorkspaceDatasetInfo {
	dataset: string;
	data_access_id: string;
	source_tool: string | null;
	row_count: number;
	completeness: unknown;
	tables: Array<{
		name: string;
		row_count: number;
		columns: Array<{ name: string; type: string }>;
	}>;
}

export interface WorkspaceSchemaResult {
	dataset_count: number;
	datasets: WorkspaceDatasetInfo[];
}

function tableColumns(sql: WorkspaceSql, table: string): Array<{ name: string; type: string }> {
	// pragma_table_info() as a table-valued function (a normal SELECT) rather than
	// a bare PRAGMA statement — portable across SqlStorage and node:sqlite.
	return sql
		.exec(`SELECT name, type FROM pragma_table_info('${table.replace(/'/g, "''")}')`)
		.toArray()
		.map((c) => ({ name: String(c.name), type: String(c.type) }));
}

function tableRowCount(sql: WorkspaceSql, table: string): number {
	const row = sql.exec(`SELECT COUNT(*) as c FROM "${table.replace(/"/g, '""')}"`).one() as { c?: number } | undefined;
	return Number(row?.c ?? 0);
}

/** The cross-server catalog: every dataset, its tables, columns and row counts. */
export function workspaceSchema(sql: WorkspaceSql, dataset?: string): WorkspaceSchemaResult {
	ensureWorkspaceTables(sql);
	const manifestRows = (dataset
		? sql.exec(`SELECT * FROM ${MANIFEST} WHERE dataset = ?`, dataset)
		: sql.exec(`SELECT * FROM ${MANIFEST} ORDER BY created_at, dataset`)
	).toArray();

	const datasets: WorkspaceDatasetInfo[] = manifestRows.map((r) => ({
		dataset: String(r.dataset),
		data_access_id: String(r.data_access_id),
		source_tool: r.source_tool == null ? null : String(r.source_tool),
		row_count: Number(r.row_count ?? 0),
		completeness: tryParseJson(r.completeness),
		tables: parseTableList(r.tables_json).map((t) => ({
			name: t,
			row_count: tableRowCount(sql, t),
			columns: tableColumns(sql, t),
		})),
	}));

	return { dataset_count: datasets.length, datasets };
}

/** GC: drop every dataset's tables and empty the manifest. */
export function clearWorkspace(sql: WorkspaceSql): void {
	ensureWorkspaceTables(sql);
	const rows = sql.exec(`SELECT tables_json FROM ${MANIFEST}`).toArray();
	for (const r of rows) {
		for (const t of parseTableList(r.tables_json)) {
			sql.exec(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
		}
	}
	sql.exec(`DELETE FROM ${MANIFEST}`);
}
