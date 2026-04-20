/**
 * REST Staging Durable Object base class.
 *
 * Generalizes the clinicaltrialsgov JsonToSqlDO pattern.
 * Subclasses override `getSchemaHints()` to customize inference.
 *
 * New hooks for the consolidated staging engine:
 *   - `getDomainConfig()` — return a DomainConfig for Tier 2 normalization
 *   - `getStagingContext()` — return request metadata for config cascade
 *   - `useConsolidatedEngine()` — opt-in to the new StagingEngine
 */

import { DurableObject } from "cloudflare:workers";
import { ChunkingEngine } from "./chunking";
import {
	detectArrays,
	inferSchema,
	materializeSchema,
	computeColumnProfiles,
	type InferredSchema,
	type InferredTable,
	type SchemaHints,
	type TableProfile,
} from "./schema-inference";
import { stageData } from "./staging-engine";
import type { DomainConfig, StagingContext, StagingHints } from "./types";
import type { TableRelationship } from "./staging-metadata";
import { VirtualFS } from "../filesystem/virtual-fs";
import { SchemaValidator } from "@bio-mcp/syntaqlite-worker";

// ---------------------------------------------------------------------------
// Request body interfaces for handleProcess / handleQuery / handleRegister
// ---------------------------------------------------------------------------

interface ProcessRequestBody {
	data?: unknown;
	context?: {
		toolName?: string;
		serverName?: string;
		args?: Record<string, unknown>;
		apiUrl?: string;
	};
	schema_hints?: SchemaHints;
}

interface SqlQueryBody {
	sql: string;
	/** When true, also runs a COUNT(*) wrapper to report total matching rows */
	count_total?: boolean;
}

interface RegisterRequestBody {
	session_id: string;
	data_access_id: string;
	tool_name?: string;
	tables?: string[];
	total_rows?: number;
	tool_prefix?: string;
}

interface SessionRegistryRow {
	data_access_id: string;
	tool_name: string | null;
	tables_json: string | null;
	total_rows: number | null;
	tool_prefix: string | null;
	created_at: string;
}

interface ProvenanceRow {
	tool_name: string | null;
	server_name: string | null;
	api_url: string | null;
	staged_at: string | null;
	input_rows: number | null;
	stored_rows: number | null;
	failed_rows: number | null;
}

// ---------------------------------------------------------------------------
// Schema hints merging — client-provided hints override server defaults
// ---------------------------------------------------------------------------

/**
 * Merge server-side schema hints with client-provided hints.
 * Client hints take precedence for overlapping keys (columnTypes, indexes, etc.).
 * Returns undefined if both inputs are undefined.
 */
function mergeSchemaHints(
	serverHints: SchemaHints | undefined,
	clientHints: SchemaHints | undefined,
): SchemaHints | undefined {
	if (!serverHints && !clientHints) return undefined;
	if (!serverHints) return clientHints;
	if (!clientHints) return serverHints;

	return {
		// Client tableName wins if set
		tableName: clientHints.tableName ?? serverHints.tableName,
		// Merge columnTypes — client overrides per-column
		columnTypes: serverHints.columnTypes || clientHints.columnTypes
			? { ...serverHints.columnTypes, ...clientHints.columnTypes }
			: undefined,
		// Merge indexes — deduplicated union
		indexes: serverHints.indexes || clientHints.indexes
			? [...new Set([...(serverHints.indexes ?? []), ...(clientHints.indexes ?? [])])]
			: undefined,
		// Merge flatten depth overrides — client wins per-key
		flatten: serverHints.flatten || clientHints.flatten
			? { ...serverHints.flatten, ...clientHints.flatten }
			: undefined,
		// Merge exclude — deduplicated union
		exclude: serverHints.exclude || clientHints.exclude
			? [...new Set([...(serverHints.exclude ?? []), ...(clientHints.exclude ?? [])])]
			: undefined,
		// Merge skipChildTables — deduplicated union
		skipChildTables: serverHints.skipChildTables || clientHints.skipChildTables
			? [...new Set([...(serverHints.skipChildTables ?? []), ...(clientHints.skipChildTables ?? [])])]
			: undefined,
		// Client maxRecursionDepth wins if set
		maxRecursionDepth: clientHints.maxRecursionDepth ?? serverHints.maxRecursionDepth,
		// Merge compositeIndexes — concatenate (de-dup by serialized form)
		compositeIndexes: serverHints.compositeIndexes || clientHints.compositeIndexes
			? deduplicateCompositeIndexes([
				...(serverHints.compositeIndexes ?? []),
				...(clientHints.compositeIndexes ?? []),
			])
			: undefined,
	};
}

/** Deduplicate composite indexes by their serialized column list. */
function deduplicateCompositeIndexes(indexes: string[][]): string[][] {
	const seen = new Set<string>();
	const result: string[][] = [];
	for (const idx of indexes) {
		const key = idx.join(",");
		if (!seen.has(key)) {
			seen.add(key);
			result.push(idx);
		}
	}
	return result;
}

/** Strip LIMIT/OFFSET clause from a SQL query for COUNT(*) wrapping. */
function stripLimit(sql: string): string {
	// Remove trailing LIMIT n [OFFSET m] — case-insensitive
	return sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, "");
}

/** Safely parse JSON, returning undefined on failure. */
function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

export class RestStagingDO extends DurableObject {
	protected chunking = new ChunkingEngine();
	private schemaValidator: SchemaValidator | null = null;
	private schemaValidatorInitFailed = false;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.migrateMetadata();
		});
	}

	/**
	 * Lazily create a SchemaValidator using the stored inferred schema.
	 * Returns null if schema is unavailable or parsing fails.
	 * Cached for the lifetime of the DO instance; invalidated on new staging.
	 */
	private getSchemaValidator(): SchemaValidator | null {
		if (this.schemaValidator) return this.schemaValidator;
		if (this.schemaValidatorInitFailed) return null;
		try {
			const row = this.ctx.storage.sql
				.exec("SELECT schema_json FROM _inferred_schema WHERE id = 1")
				.one() as { schema_json: string } | undefined;
			if (!row?.schema_json) return null;
			const schema = JSON.parse(row.schema_json) as InferredSchema;
			this.schemaValidator = new SchemaValidator(schema);
			return this.schemaValidator;
		} catch {
			this.schemaValidatorInitFailed = true;
			return null;
		}
	}

	/**
	 * Validate SQL before execution. Returns an error response if validation
	 * finds errors (e.g., unknown columns with "did you mean?" suggestions),
	 * or null if the query should proceed to execution.
	 */
	private validateSql(sql: string): Response | null {
		const validator = this.getSchemaValidator();
		if (!validator) return null;
		const result = validator.validate(sql);
		if (result.valid) return null;
		return this.jsonResponse(
			{
				success: false,
				error: SchemaValidator.formatErrorMessage(result),
				diagnostics: result.diagnostics,
				validated: true,
			},
			400,
		);
	}

	/**
	 * Versioned migration for internal metadata tables.
	 * All metadata tables are created here so they exist before any handler runs.
	 * Future schema changes (ALTER TABLE, new indexes) go as new version blocks.
	 */
	private migrateMetadata(): void {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS _do_migrations (
				id INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);

		const row = this.ctx.storage.sql
			.exec("SELECT COALESCE(MAX(id), 0) as v FROM _do_migrations")
			.one() as { v: number };
		const version = row.v;

		if (version < 1) {
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS _staging_metadata (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					tool_name TEXT,
					server_name TEXT,
					args_json TEXT,
					api_url TEXT,
					staged_at TEXT DEFAULT CURRENT_TIMESTAMP,
					input_rows INTEGER,
					stored_rows INTEGER,
					failed_rows INTEGER,
					warnings_json TEXT
				)`,
			);
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS _inferred_schema (
					id INTEGER PRIMARY KEY,
					schema_json TEXT
				)`,
			);
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS _column_profiles (
					id INTEGER PRIMARY KEY,
					profiles_json TEXT
				)`,
			);
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS _session_registry (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					session_id TEXT NOT NULL,
					data_access_id TEXT NOT NULL,
					tool_name TEXT,
					tables_json TEXT,
					total_rows INTEGER,
					tool_prefix TEXT,
					created_at TEXT DEFAULT CURRENT_TIMESTAMP
				)`,
			);
			this.ctx.storage.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_session_registry_session_time
					ON _session_registry(session_id, created_at)`,
			);
			this.ctx.storage.sql.exec(
				`INSERT INTO _do_migrations (id) VALUES (1)`,
			);
		}

		// Future migrations go here:
		// if (version < 2) { ... INSERT INTO _do_migrations (id) VALUES (2); }
	}

	/** Override in subclass to provide domain-specific schema hints (Tier 1) */
	protected getSchemaHints(_data: unknown): SchemaHints | undefined {
		return undefined;
	}

	/**
	 * Override in subclass to return a DomainConfig for Tier 2 normalization.
	 * When this returns non-undefined and useConsolidatedEngine() returns true,
	 * the consolidated StagingEngine is used instead of the Tier 1 pipeline.
	 */
	protected getDomainConfig(): DomainConfig | undefined {
		return undefined;
	}

	/**
	 * Override in subclass to provide request metadata for config cascade.
	 */
	protected getStagingContext(_request: Request): StagingContext | undefined {
		return undefined;
	}

	/**
	 * Override in subclass to return staging hints for the consolidated engine.
	 */
	protected getStagingHints(_data: unknown): StagingHints | undefined {
		return undefined;
	}

	/**
	 * Override to return true to opt-in to the consolidated staging engine.
	 * Default is false for backward compatibility.
	 */
	protected useConsolidatedEngine(): boolean {
		return false;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/process" && request.method === "POST") {
				return await this.handleProcess(request);
			}
			if (url.pathname === "/query" && request.method === "POST") {
				return await this.handleQuery(request);
			}
			if (url.pathname === "/query-enhanced" && request.method === "POST") {
				return await this.handleQueryEnhanced(request);
			}
			if (url.pathname === "/schema" && request.method === "GET") {
				return await this.handleSchema();
			}
			if (url.pathname === "/register" && request.method === "POST") {
				return await this.handleRegister(request);
			}
			if (url.pathname === "/list" && request.method === "GET") {
				const sessionId = url.searchParams.get("session_id") ?? undefined;
				return await this.handleList(sessionId);
			}
			if (url.pathname === "/delete" && request.method === "DELETE") {
				await this.ctx.storage.deleteAll();
				return this.jsonResponse({ success: true });
			}
			if (url.pathname.startsWith("/fs/") && request.method === "POST") {
				return await this.handleFs(url.pathname.slice(4), request);
			}
			return new Response("Not Found", { status: 404 });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return this.jsonResponse({ success: false, error: message }, 500);
		}
	}

	/**
	 * Store provenance metadata about how/when data was staged.
	 */
	private storeProvenance(context?: {
		toolName?: string;
		serverName?: string;
		args?: Record<string, unknown>;
		apiUrl?: string;
	}): void {
		if (context) {
			this.ctx.storage.sql.exec(
				`INSERT INTO _staging_metadata (tool_name, server_name, args_json, api_url) VALUES (?, ?, ?, ?)`,
				context.toolName ?? null,
				context.serverName ?? null,
				context.args ? JSON.stringify(context.args) : null,
				context.apiUrl ?? null,
			);
		}
	}

	/**
	 * Update provenance with row counts after materialization.
	 */
	private updateProvenanceRowCounts(
		inputRows: number,
		storedRows: number,
		failedRows: number,
		warnings: unknown[],
	): void {
		try {
			this.ctx.storage.sql.exec(
				`UPDATE _staging_metadata SET input_rows = ?, stored_rows = ?, failed_rows = ?, warnings_json = ? WHERE id = (SELECT MAX(id) FROM _staging_metadata)`,
				inputRows,
				storedRows,
				failedRows,
				warnings.length > 0 ? JSON.stringify(warnings) : null,
			);
		} catch {
			// Don't fail staging if metadata update fails
		}
	}

	/**
	 * Persist the inferred schema so handleSchema() can surface
	 * relationships, jsonShape, and pipe-delimited column metadata.
	 */
	private persistInferredSchema(schema: InferredSchema): void {
		try {
			// MERGE with existing schema instead of overwriting: when a single DO
			// receives multiple stageToDoAndRespond() calls (e.g. l2g_gather fans
			// out to anchors/loci/candidate_genes/... across separate calls), each
			// call previously clobbered the validator's view of prior tables.
			// Dedupe by table name — last-writer-wins for the same table.
			const existing = this.readInferredSchemaUnsafe();
			const byName = new Map<string, InferredTable>();
			if (existing) {
				for (const t of existing.tables) byName.set(t.name, t);
			}
			for (const t of schema.tables) byName.set(t.name, t);
			const merged: InferredSchema = { tables: Array.from(byName.values()) };

			this.ctx.storage.sql.exec(
				`INSERT OR REPLACE INTO _inferred_schema (id, schema_json) VALUES (1, ?)`,
				JSON.stringify(merged),
			);
			// Invalidate cached validator so it rebuilds with the merged schema
			this.schemaValidator = null;
			this.schemaValidatorInitFailed = false;
		} catch {
			// Non-critical — schema still works via PRAGMA, just without enrichment
		}
	}

	/** Read the persisted inferred schema, or null if absent / malformed. */
	private readInferredSchemaUnsafe(): InferredSchema | null {
		try {
			const row = this.ctx.storage.sql
				.exec("SELECT schema_json FROM _inferred_schema WHERE id = 1")
				.one() as { schema_json: string } | undefined;
			if (!row?.schema_json) return null;
			return JSON.parse(row.schema_json) as InferredSchema;
		} catch {
			return null;
		}
	}

	/**
	 * Compute and persist column profiles after materialization.
	 * Profiles are stored in _column_profiles so handleSchema() can include them.
	 */
	private persistColumnProfiles(schema: InferredSchema): void {
		try {
			const profiles = computeColumnProfiles(schema, this.ctx.storage.sql);
			this.ctx.storage.sql.exec(
				`INSERT OR REPLACE INTO _column_profiles (id, profiles_json) VALUES (1, ?)`,
				JSON.stringify(profiles),
			);
		} catch {
			// Non-critical — schema still works without profiles
		}
	}

	/**
	 * Extract parent→child relationships from an InferredSchema.
	 */
	private extractRelationships(schema: InferredSchema): TableRelationship[] {
		const relationships: TableRelationship[] = [];
		for (const table of schema.tables) {
			if (table.childOf) {
				relationships.push({
					child_table: table.name,
					parent_table: table.childOf.parentTable,
					fk_column: table.childOf.fkColumn,
					source_column: table.childOf.sourceColumn,
				});
			}
		}
		return relationships;
	}

	private async handleProcess(request: Request): Promise<Response> {
		const raw: unknown = await request.json();
		const container: ProcessRequestBody = (raw !== null && typeof raw === "object" ? raw : {}) as ProcessRequestBody;
		const data = container.data ?? raw;

		// Extract provenance context from request body
		this.storeProvenance(container.context);

		// Extract client-provided schema hints (from isolate db.stage() calls)
		const clientHints = container.schema_hints;

		// Use consolidated staging engine if opted in
		if (this.useConsolidatedEngine()) {
			const domainConfig = this.getDomainConfig();
			const context = this.getStagingContext(request);
			const stagingHints = this.getStagingHints(data);

			const result = this.ctx.storage.transactionSync(() =>
				stageData(
					data,
					this.ctx.storage.sql,
					context,
					stagingHints,
					domainConfig,
				),
			);

			return this.jsonResponse({
				success: result.success,
				tier: result.tier,
				table_count: result.tablesCreated.length,
				total_rows: result.totalRows,
				tables_created: result.tablesCreated,
				...(result.error ? { error: result.error } : {}),
			});
		}

		// Legacy Tier 1 pipeline — merge server-side hints with client-provided hints
		const serverHints = this.getSchemaHints(data);
		const hints = mergeSchemaHints(serverHints, clientHints);
		const arrays = detectArrays(data);

		if (arrays.length > 0 && arrays.some((a) => a.rows.length > 0)) {
			const schema = inferSchema(arrays, hints);

			// Persist inferred schema for enriched handleSchema() output
			this.persistInferredSchema(schema);
			// Compute and persist column profiles after schema inference
			// (must come after materializeSchema — we do it below)

			const rowsMap = new Map<string, unknown[]>();
			for (const arr of arrays) {
				const tableName = hints?.tableName ?? arr.key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
				const actualName = schema.tables.length === 1
					? schema.tables[0].name
					: schema.tables.find((t) => t.name === tableName)?.name ?? tableName;
				rowsMap.set(actualName, arr.rows);
			}

			const result = this.ctx.storage.transactionSync(() =>
				materializeSchema(
					schema,
					rowsMap,
					this.ctx.storage.sql,
				),
			);

			// Track row counts in provenance
			this.updateProvenanceRowCounts(
				result.inputRows,
				result.totalRows,
				result.failedRows,
				result.warnings,
			);

			// Compute and persist column profiles (runs SQL against the just-populated tables)
			this.persistColumnProfiles(schema);

			// Extract relationships from schema
			const relationships = this.extractRelationships(schema);

			// Build staging warnings if data was lost
			const stagingWarnings: Record<string, unknown> = {};
			if (result.failedRows > 0) {
				stagingWarnings.rows_skipped = result.failedRows;
				stagingWarnings.sample_errors = result.warnings.slice(0, 5).map((w) => ({
					row: w.rowIndex,
					table: w.table,
					error: w.error,
				}));
			}
			const lossPercent = result.inputRows > 0
				? (result.failedRows / result.inputRows) * 100
				: 0;
			if (lossPercent > 5) {
				stagingWarnings.data_loss_warning =
					`${result.failedRows} of ${result.inputRows} rows (${lossPercent.toFixed(1)}%) failed to stage. ` +
					`This exceeds the 5% threshold. Review sample_errors for details.`;
			}

			return this.jsonResponse({
				success: true,
				table_count: result.tablesCreated.length,
				total_rows: result.totalRows,
				input_rows: result.inputRows,
				table_row_counts: result.tableRowCounts,
				tables_created: result.tablesCreated,
				...(relationships.length > 0 ? { relationships } : {}),
				...(Object.keys(stagingWarnings).length > 0 ? { staging_warnings: stagingWarnings } : {}),
			});
		}

		// Fallback: store entire payload as chunked JSON
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS payloads (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				root_json TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`,
		);
		const jsonStr = await this.chunking.smartJsonStringify(
			data,
			this.ctx.storage.sql,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO payloads (root_json) VALUES (?)`,
			jsonStr,
		);
		const count =
			(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM payloads`).one() as { c: number })
				?.c ?? 0;
		return this.jsonResponse({
			success: true,
			table_count: 1,
			total_rows: count,
			tables_created: ["payloads"],
		});
	}

	private async handleQuery(request: Request): Promise<Response> {
		const raw: unknown = await request.json();
		const body: SqlQueryBody = (raw !== null && typeof raw === "object" ? raw : { sql: "" }) as SqlQueryBody;

		// Pre-execution schema validation — catches column/table typos with suggestions
		const validationError = this.validateSql(body.sql);
		if (validationError) return validationError;

		const res = this.ctx.storage.sql.exec(body.sql);
		const results = res.toArray();

		// If count_total requested, run a COUNT(*) wrapper to determine total matching rows
		let totalMatching: number | undefined;
		let truncated: boolean | undefined;
		if (body.count_total) {
			try {
				// Wrap the user's query (with LIMIT stripped) in a COUNT(*)
				const countSql = `SELECT COUNT(*) as c FROM (${stripLimit(body.sql)})`;
				const countResult = this.ctx.storage.sql.exec(countSql).one();
				totalMatching = Number((countResult as { c: number })?.c ?? results.length);
				truncated = totalMatching > results.length;
			} catch {
				// If COUNT wrapper fails (e.g. complex CTEs), just report based on results
				truncated = undefined;
				totalMatching = undefined;
			}
		}

		return this.jsonResponse({
			success: true,
			results,
			row_count: results.length,
			...(truncated !== undefined ? { truncated } : {}),
			...(totalMatching !== undefined ? { total_matching: totalMatching } : {}),
		});
	}

	private async handleQueryEnhanced(request: Request): Promise<Response> {
		const rawEnhanced: unknown = await request.json();
		const body: SqlQueryBody = (rawEnhanced !== null && typeof rawEnhanced === "object" ? rawEnhanced : { sql: "" }) as SqlQueryBody;

		// Pre-execution schema validation — catches column/table typos with suggestions
		const validationError = this.validateSql(body.sql);
		if (validationError) return validationError;

		const res = this.ctx.storage.sql.exec(body.sql);
		const rows = res.toArray();
		const enhanced: Record<string, unknown>[] = [];
		for (const row of rows) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(row)) {
				if (typeof v === "string" && this.chunking.isContentReference(v)) {
					const id = this.chunking.extractContentId(v);
					const content = await this.chunking.retrieveChunkedContent(
						id,
						this.ctx.storage.sql,
					);
					try {
						out[k] = content ? JSON.parse(content) : null;
					} catch {
						out[k] = content;
					}
				} else {
					out[k] = v;
				}
			}
			enhanced.push(out);
		}

		// Truncation support for enhanced queries
		let totalMatching: number | undefined;
		let truncated: boolean | undefined;
		if (body.count_total) {
			try {
				const countSql = `SELECT COUNT(*) as c FROM (${stripLimit(body.sql)})`;
				const countResult = this.ctx.storage.sql.exec(countSql).one();
				totalMatching = Number((countResult as { c: number })?.c ?? enhanced.length);
				truncated = totalMatching > enhanced.length;
			} catch {
				truncated = undefined;
				totalMatching = undefined;
			}
		}

		return this.jsonResponse({
			success: true,
			results: enhanced,
			row_count: enhanced.length,
			...(truncated !== undefined ? { truncated } : {}),
			...(totalMatching !== undefined ? { total_matching: totalMatching } : {}),
		});
	}

	private async handleSchema(): Promise<Response> {
		const tables: Record<
			string,
			{
				row_count: number;
				columns: Array<{
					name: string;
					type: string;
					not_null: boolean;
					primary_key: boolean;
					json_shape?: string;
					searchable_array?: boolean;
				}>;
			}
		> = {};
		let totalRows = 0;

		// Load persisted inferred schema for enrichment
		let inferredSchema: InferredSchema | undefined;
		try {
			const schemaResults = this.ctx.storage.sql
				.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name = '_inferred_schema'`)
				.toArray();
			if (schemaResults.length > 0) {
				const schemaRow = this.ctx.storage.sql
					.exec(`SELECT schema_json FROM _inferred_schema WHERE id = 1`)
					.one() as { schema_json: string } | undefined;
				if (schemaRow?.schema_json) {
					inferredSchema = JSON.parse(schemaRow.schema_json) as InferredSchema;
				}
			}
		} catch {
			// Non-critical — fall back to PRAGMA-only output
		}

		// Build column metadata lookup from inferred schema
		const columnMeta = new Map<string, { jsonShape?: string; pipeDelimited?: boolean }>();
		if (inferredSchema) {
			for (const table of inferredSchema.tables) {
				for (const col of table.columns) {
					const key = `${table.name}.${col.name}`;
					if (col.jsonShape || col.pipeDelimited) {
						columnMeta.set(key, {
							jsonShape: col.jsonShape,
							pipeDelimited: col.pipeDelimited,
						});
					}
				}
			}
		}

		// Load persisted column profiles
		let columnProfiles: TableProfile[] | undefined;
		try {
			const profileResults = this.ctx.storage.sql
				.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name = '_column_profiles'`)
				.toArray();
			if (profileResults.length > 0) {
				const profileRow = this.ctx.storage.sql
					.exec(`SELECT profiles_json FROM _column_profiles WHERE id = 1`)
					.one() as { profiles_json: string } | undefined;
				if (profileRow?.profiles_json) {
					columnProfiles = JSON.parse(profileRow.profiles_json) as TableProfile[];
				}
			}
		} catch {
			// Non-critical
		}

		// Build profile lookup: tableName → { colName → ColumnProfile }
		const profileByTable = new Map<string, Record<string, unknown>>();
		if (columnProfiles) {
			for (const tp of columnProfiles) {
				profileByTable.set(tp.table, tp.columns as unknown as Record<string, unknown>);
			}
		}

		const tableResults = this.ctx.storage.sql
			.exec(
				`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_staging_%' AND name NOT IN ('_inferred_schema', '_column_profiles')`,
			)
			.toArray();

		for (const table of tableResults) {
			const tableName = table.name as string;
			const columnResults = this.ctx.storage.sql
				.exec(`PRAGMA table_info(${tableName})`)
				.toArray();
			const countResult = this.ctx.storage.sql
				.exec(`SELECT COUNT(*) as count FROM "${tableName}"`)
				.one();
			const rowCount = Number((countResult as { count: number })?.count || 0);
			totalRows += rowCount;

			tables[tableName] = {
				row_count: rowCount,
				columns: columnResults.map((col: Record<string, unknown>) => {
					const colName = col.name as string;
					const meta = columnMeta.get(`${tableName}.${colName}`);
					const tableProfiles = profileByTable.get(tableName) as Record<string, Record<string, unknown>> | undefined;
					const colProfile = tableProfiles?.[colName];
					return {
						name: colName,
						type: col.type as string,
						not_null: col.notnull === 1,
						primary_key: col.pk === 1,
						...(meta?.jsonShape ? { json_shape: meta.jsonShape } : {}),
						...(meta?.pipeDelimited ? { searchable_array: true } : {}),
						...(colProfile ? { profile: colProfile } : {}),
					};
				}),
			};
		}

		// Extract relationships from inferred schema
		const relationships: TableRelationship[] = inferredSchema
			? this.extractRelationships(inferredSchema)
			: [];

		// Generate sample JOIN SQL for each relationship
		const relationshipsWithJoins = relationships.map((rel) => {
			// Determine parent PK column: if parent has a data "id" column, PK is _rowid
			const parentTable = inferredSchema?.tables.find((t) => t.name === rel.parent_table);
			const parentHasDataId = parentTable?.columns.some((c) => c.name === "id") ?? false;
			const parentKeyCol = parentHasDataId ? "_rowid" : "id";
			return {
				...rel,
				join_sql: `SELECT p.*, c.* FROM "${rel.parent_table}" p JOIN "${rel.child_table}" c ON c.parent_id = p.${parentKeyCol}`,
			};
		});

		// Include provenance metadata if available
		let provenance: ProvenanceRow | undefined;
		try {
			const metaResults = this.ctx.storage.sql
				.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name = '_staging_metadata'`)
				.toArray();
			if (metaResults.length > 0) {
				const metaRow = this.ctx.storage.sql
					.exec(`SELECT tool_name, server_name, api_url, staged_at, input_rows, stored_rows, failed_rows FROM _staging_metadata ORDER BY id DESC LIMIT 1`)
					.toArray();
				const first = metaRow[0];
				if (first !== undefined) {
					provenance = {
						tool_name: typeof first.tool_name === "string" ? first.tool_name : null,
						server_name: typeof first.server_name === "string" ? first.server_name : null,
						api_url: typeof first.api_url === "string" ? first.api_url : null,
						staged_at: typeof first.staged_at === "string" ? first.staged_at : null,
						input_rows: typeof first.input_rows === "number" ? first.input_rows : null,
						stored_rows: typeof first.stored_rows === "number" ? first.stored_rows : null,
						failed_rows: typeof first.failed_rows === "number" ? first.failed_rows : null,
					};
				}
			}
		} catch {
			// Ignore — provenance is optional
		}

		return this.jsonResponse({
			success: true,
			schema: {
				table_count: Object.keys(tables).length,
				total_rows: totalRows,
				tables,
				...(relationshipsWithJoins.length > 0 ? { relationships: relationshipsWithJoins } : {}),
				metadata: {
					timestamp: new Date().toISOString(),
					...(provenance ? { provenance } : {}),
				},
			},
		});
	}

	/**
	 * Register a staged data_access_id against a session.
	 * Called on the __registry__ DO instance by stageToDoAndRespond().
	 */
	private async handleRegister(request: Request): Promise<Response> {
		const rawRegister: unknown = await request.json();
		const body: RegisterRequestBody = (rawRegister !== null && typeof rawRegister === "object" ? rawRegister : {}) as RegisterRequestBody;

		if (!body.session_id || !body.data_access_id) {
			return this.jsonResponse(
				{ success: false, error: "session_id and data_access_id are required" },
				400,
			);
		}

		// TTL cleanup: remove entries older than 24h
		this.ctx.storage.sql.exec(
			`DELETE FROM _session_registry WHERE created_at < datetime('now', '-24 hours')`,
		);

		this.ctx.storage.sql.exec(
			`INSERT INTO _session_registry (session_id, data_access_id, tool_name, tables_json, total_rows, tool_prefix) VALUES (?, ?, ?, ?, ?, ?)`,
			body.session_id,
			body.data_access_id,
			body.tool_name ?? null,
			body.tables ? JSON.stringify(body.tables) : null,
			body.total_rows ?? null,
			body.tool_prefix ?? null,
		);

		return this.jsonResponse({ success: true });
	}

	/**
	 * List staged data_access_ids for a session.
	 * Called on the __registry__ DO instance by get_schema when data_access_id is omitted.
	 */
	private async handleList(sessionId?: string): Promise<Response> {
		// Check if the registry table exists
		const tableExists = this.ctx.storage.sql
			.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='_session_registry'`)
			.toArray();
		if (tableExists.length === 0) {
			return this.jsonResponse({ success: true, datasets: [] });
		}

		// TTL cleanup
		this.ctx.storage.sql.exec(
			`DELETE FROM _session_registry WHERE created_at < datetime('now', '-24 hours')`,
		);

		if (!sessionId) {
			return this.jsonResponse({ success: true, datasets: [] });
		}

		const rows = this.ctx.storage.sql
			.exec(
				`SELECT data_access_id, tool_name, tables_json, total_rows, tool_prefix, created_at FROM _session_registry WHERE session_id = ? ORDER BY created_at DESC`,
				sessionId,
			)
			.toArray();

		const datasets = rows.map((row) => {
			const r = row as unknown as SessionRegistryRow;
			const parsedTables = typeof r.tables_json === "string"
				? (safeJsonParse(r.tables_json) ?? [])
				: [];
			return {
				data_access_id: r.data_access_id,
				tool_name: r.tool_name,
				tables: Array.isArray(parsedTables) ? parsedTables : [],
				total_rows: r.total_rows,
				tool_prefix: r.tool_prefix,
				created_at: r.created_at,
			};
		});

		return this.jsonResponse({ success: true, datasets });
	}

	// -----------------------------------------------------------------------
	// Virtual Filesystem — persistent scratch storage for Code Mode isolates
	// -----------------------------------------------------------------------

	private _vfs: VirtualFS | undefined;
	private get vfs(): VirtualFS {
		if (!this._vfs) {
			this._vfs = new VirtualFS(this.ctx.storage.sql);
		}
		return this._vfs;
	}

	private async handleFs(action: string, request: Request): Promise<Response> {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			let data: unknown;
			switch (action) {
				case "read":
					data = this.vfs.readFile(String(body.path));
					break;
				case "write":
					data = this.vfs.writeFile(String(body.path), String(body.content));
					break;
				case "append":
					data = this.vfs.appendFile(String(body.path), String(body.content));
					break;
				case "mkdir":
					this.vfs.mkdir(String(body.path), {
						recursive: body.recursive !== false,
					});
					data = { success: true };
					break;
				case "readdir":
					data = this.vfs.readdir(String(body.path || "/"));
					break;
				case "stat":
					data = this.vfs.stat(String(body.path));
					break;
				case "exists":
					data = this.vfs.exists(String(body.path));
					break;
				case "rm":
					this.vfs.rm(String(body.path), {
						recursive: body.recursive !== false,
					});
					data = { success: true };
					break;
				case "glob":
					data = this.vfs.glob(String(body.pattern));
					break;
				default:
					return this.jsonResponse(
						{ success: false, error: `Unknown fs action: ${action}` },
						404,
					);
			}
			return this.jsonResponse({ success: true, data });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return this.jsonResponse({ success: false, error: message }, 400);
		}
	}

	private jsonResponse(data: unknown, status = 200): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}
}
