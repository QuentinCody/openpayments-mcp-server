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
import { SchemaValidator } from "@bio-mcp/syntaqlite-worker";
import { VirtualFS } from "../filesystem/virtual-fs";
import { ChunkingEngine } from "./chunking";
import {
	countTotal,
	parseSqlQueryBody,
	pullBoundedRows,
	pullSignals,
	queryCostError,
	readOnlySqlError,
	type SqlQueryBody,
} from "./query-endpoint";
import { mergeSchemaHints } from "./schema-hints";
import {
	computeColumnProfiles,
	detectArrays,
	type InferredSchema,
	type InferredTable,
	inferSchema,
	materializeSchema,
	type SchemaHints,
	type TableProfile,
} from "./schema-inference";
import {
	buildColumnDescriptor,
	buildColumnMeta,
	buildProfileByTable,
	buildRelationshipJoins,
	normalizeProvenance,
	type ProvenanceRow,
} from "./schema-response";
import { stageData } from "./staging-engine";
import type { TableRelationship } from "./staging-metadata";
import type { DomainConfig, StagingContext, StagingHints } from "./types";

// ---------------------------------------------------------------------------
// Request body interfaces for handleProcess / handleRegister
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

// Schema-hint merging (`mergeSchemaHints`) lives in ./schema-hints so the pure
// logic can be unit-tested without loading this module's `cloudflare:workers`
// import. See schema-hints.test.ts. The SQL query-endpoint helpers
// (`SqlQueryBody`, `parseSqlQueryBody`, `readOnlySqlError`, `countTotal`,
// `stripLimit`) live in ./query-endpoint for the same reason — see
// query-endpoint.test.ts.

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

	protected get sql() {
		return this.ctx.storage.sql;
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
			const row = this.sql
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
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS _do_migrations (
				id INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);

		const row = this.sql
			.exec("SELECT COALESCE(MAX(id), 0) as v FROM _do_migrations")
			.one() as { v: number };
		const version = row.v;

		if (version < 1) {
			this.sql.exec(
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
			this.sql.exec(
				`CREATE TABLE IF NOT EXISTS _inferred_schema (
					id INTEGER PRIMARY KEY,
					schema_json TEXT
				)`,
			);
			this.sql.exec(
				`CREATE TABLE IF NOT EXISTS _column_profiles (
					id INTEGER PRIMARY KEY,
					profiles_json TEXT
				)`,
			);
			this.sql.exec(
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
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_session_registry_session_time
					ON _session_registry(session_id, created_at)`,
			);
			this.sql.exec(`INSERT INTO _do_migrations (id) VALUES (1)`);
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
			this.sql.exec(
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
			this.sql.exec(
				`UPDATE _staging_metadata SET input_rows = ?, stored_rows = ?, failed_rows = ?, warnings_json = ? WHERE id = (SELECT MAX(id) FROM _staging_metadata)`,
				inputRows,
				storedRows,
				failedRows,
				warnings.length > 0 ? JSON.stringify(warnings) : null,
			);
		} catch {
			/* best-effort: Don't fail staging if metadata update fails */
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

			this.sql.exec(
				`INSERT OR REPLACE INTO _inferred_schema (id, schema_json) VALUES (1, ?)`,
				JSON.stringify(merged),
			);
			// Invalidate cached validator so it rebuilds with the merged schema
			this.schemaValidator = null;
			this.schemaValidatorInitFailed = false;
		} catch {
			/* best-effort: — schema still works via PRAGMA, just without enrichment */
		}
	}

	/** Read the persisted inferred schema, or null if absent / malformed. */
	private readInferredSchemaUnsafe(): InferredSchema | null {
		try {
			const row = this.sql
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
			const profiles = computeColumnProfiles(schema, this.sql);
			this.sql.exec(
				`INSERT OR REPLACE INTO _column_profiles (id, profiles_json) VALUES (1, ?)`,
				JSON.stringify(profiles),
			);
		} catch {
			/* best-effort: — schema still works without profiles */
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
		const container: ProcessRequestBody = (
			raw !== null && typeof raw === "object" ? raw : {}
		) as ProcessRequestBody;
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
				stageData(data, this.sql, context, stagingHints, domainConfig),
			);

			// #8: reach parity with the legacy path. The consolidated engine used to
			// drop the inferred schema, so get_schema had no relationships/join_sql/
			// column-hints and the /process response carried no relationships or
			// per-table row counts - forcing clients to sqlite_master-spelunk before
			// every analytical query. Persist the schema and surface both inline.
			let relationships: TableRelationship[] = [];
			if (result.inferredSchema) {
				this.persistInferredSchema(result.inferredSchema);
				this.persistColumnProfiles(result.inferredSchema);
				relationships = this.extractRelationships(result.inferredSchema);
				this.updateProvenanceRowCounts(
					result.inputRows ?? result.totalRows,
					result.totalRows,
					result.failedRows ?? 0,
					result.materializationWarnings ?? [],
				);
			}

			return this.jsonResponse({
				success: result.success,
				tier: result.tier,
				table_count: result.tablesCreated.length,
				total_rows: result.totalRows,
				tables_created: result.tablesCreated,
				...(result.tableRowCounts
					? { table_row_counts: result.tableRowCounts }
					: {}),
				...(relationships.length > 0 ? { relationships } : {}),
				...(result.error ? { error: result.error } : {}),
			});
		}

		// Legacy Tier 1 pipeline — merge server-side hints with client-provided hints
		const serverHints = this.getSchemaHints(data);
		const hints = mergeSchemaHints(serverHints, clientHints);
		const arrays = detectArrays(data);

		if (arrays.length > 0 && arrays.some((a) => a.rows.length > 0)) {
			try {
				const schema = inferSchema(arrays, hints);
				// Persist inferred schema for enriched handleSchema() output
				this.persistInferredSchema(schema);
				const rowsMap = new Map<string, unknown[]>();
				for (const arr of arrays) {
					const tableName =
						hints?.tableName ??
						arr.key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
					const actualName =
						schema.tables.length === 1
							? schema.tables[0].name
							: (schema.tables.find((t) => t.name === tableName)?.name ??
								tableName);
					rowsMap.set(actualName, arr.rows);
				}

				const result = this.ctx.storage.transactionSync(() =>
					materializeSchema(schema, rowsMap, this.sql),
				);

				// Track row counts in provenance
				this.updateProvenanceRowCounts(
					result.inputRows,
					result.totalRows,
					result.failedRows,
					result.warnings,
				);
				// Compute and persist column profiles (runs SQL against populated tables)
				this.persistColumnProfiles(schema);
				const relationships = this.extractRelationships(schema);
				// Build staging warnings if data was lost
				const stagingWarnings: Record<string, unknown> = {};
				if (result.failedRows > 0) {
					stagingWarnings.rows_skipped = result.failedRows;
					stagingWarnings.sample_errors = result.warnings
						.slice(0, 5)
						.map((w) => ({ row: w.rowIndex, table: w.table, error: w.error }));
				}
				const lossPercent =
					result.inputRows > 0
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
					...(Object.keys(stagingWarnings).length > 0
						? { staging_warnings: stagingWarnings }
						: {}),
				});
			} catch (matErr) {
				console.warn("T5.3 staging fallback: materialization failed", matErr);
			}
		}

		// Fallback: store entire payload as chunked JSON
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS payloads (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				root_json TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`,
		);
		const jsonStr = await this.chunking.smartJsonStringify(data, this.sql);
		this.sql.exec(`INSERT INTO payloads (root_json) VALUES (?)`, jsonStr);
		const count =
			(this.sql.exec(`SELECT COUNT(*) as c FROM payloads`).one() as { c: number })?.c ?? 0;
		return this.jsonResponse({
			success: true,
			table_count: 1,
			total_rows: count,
			tables_created: ["payloads"],
			// Per-table count like the tabular path (line ~510). Without it the
			// client's pagination denominator was undefined, so a partial slice of a
			// large result was stamped complete:true — a silent under-count (doc 10).
			table_row_counts: { payloads: count },
		});
	}

	/**
	 * Pre-flight gate for the query endpoints: read-only-by-default (doc 02) and
	 * the unbounded-read shape check (doc 03). Runs BEFORE `validateSql` and
	 * before any `exec`, so a caller that reaches this DO directly can neither
	 * execute write/DDL SQL nor start an unbounded recursive scan.
	 */
	private queryBlocked(body: SqlQueryBody): Response | null {
		const error = readOnlySqlError(body) ?? queryCostError(body);
		return error ? this.jsonResponse(error, 400) : null;
	}

	/** Bounded materialization + the QUERY_COST_LIMIT response (doc 03 §2). */
	private costLimit(pull: { cost_error?: string }): Response | null {
		return pull.cost_error
			? this.jsonResponse(
					{ success: false, error: pull.cost_error, code: "QUERY_COST_LIMIT" },
					400,
				)
			: null;
	}

	private async handleQuery(request: Request): Promise<Response> {
		const body = parseSqlQueryBody(await request.json());

		const blocked = this.queryBlocked(body);
		if (blocked) return blocked;

		// Pre-execution schema validation — catches column/table typos with suggestions
		const validationError = this.validateSql(body.sql);
		if (validationError) return validationError;

		const pull = pullBoundedRows(this.sql.exec(body.sql));
		const tooCostly = this.costLimit(pull);
		if (tooCostly) return tooCostly;
		const results = pull.rows;

		return this.jsonResponse({
			success: true,
			results,
			row_count: results.length,
			...(body.count_total
				? countTotal((s) => this.sql.exec(s), body.sql, results.length)
				: {}),
			// Spread last: an explicit pull truncation outranks the COUNT heuristic.
			...pullSignals(pull),
		});
	}

	private async handleQueryEnhanced(request: Request): Promise<Response> {
		const body = parseSqlQueryBody(await request.json());

		const blocked = this.queryBlocked(body);
		if (blocked) return blocked;

		// Pre-execution schema validation — catches column/table typos with suggestions
		const validationError = this.validateSql(body.sql);
		if (validationError) return validationError;

		// NOTE: the byte cap here measures rows as STORED. Chunked content
		// references are expanded below, so an enhanced response can still exceed
		// MAX_RESULT_BYTES — expansion is the feature. The row and scan caps bound
		// the SQLite side either way.
		const pull = pullBoundedRows(this.sql.exec(body.sql));
		const tooCostly = this.costLimit(pull);
		if (tooCostly) return tooCostly;
		const rows = pull.rows;
		const enhanced: Record<string, unknown>[] = [];
		for (const row of rows) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(row)) {
				if (typeof v === "string" && this.chunking.isContentReference(v)) {
					const id = this.chunking.extractContentId(v);
					const content = await this.chunking.retrieveChunkedContent(
						id,
						this.sql,
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

		return this.jsonResponse({
			success: true,
			results: enhanced,
			row_count: enhanced.length,
			...(body.count_total
				? countTotal((s) => this.sql.exec(s), body.sql, enhanced.length)
				: {}),
			// Spread last: an explicit pull truncation outranks the COUNT heuristic.
			...pullSignals(pull),
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
			const schemaResults = this.sql
				.exec(
					`SELECT name FROM sqlite_master WHERE type='table' AND name = '_inferred_schema'`,
				)
				.toArray();
			if (schemaResults.length > 0) {
				const schemaRow = this.sql
					.exec(`SELECT schema_json FROM _inferred_schema WHERE id = 1`)
					.one() as { schema_json: string } | undefined;
				if (schemaRow?.schema_json) {
					inferredSchema = JSON.parse(schemaRow.schema_json) as InferredSchema;
				}
			}
		} catch {
			/* best-effort: — fall back to PRAGMA-only output */
		}

		// Build column metadata lookup from inferred schema
		const columnMeta = buildColumnMeta(inferredSchema);

		// Load persisted column profiles
		let columnProfiles: TableProfile[] | undefined;
		try {
			const profileResults = this.sql
				.exec(
					`SELECT name FROM sqlite_master WHERE type='table' AND name = '_column_profiles'`,
				)
				.toArray();
			if (profileResults.length > 0) {
				const profileRow = this.sql
					.exec(`SELECT profiles_json FROM _column_profiles WHERE id = 1`)
					.one() as { profiles_json: string } | undefined;
				if (profileRow?.profiles_json) {
					columnProfiles = JSON.parse(
						profileRow.profiles_json,
					) as TableProfile[];
				}
			}
		} catch {
			/* best-effort: non-critical fallback */
		}

		// Build profile lookup: tableName → { colName → ColumnProfile }
		const profileByTable = buildProfileByTable(columnProfiles);

		const tableResults = this.sql
			.exec(
				`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_staging_%' AND name NOT IN ('_inferred_schema', '_column_profiles')`,
			)
			.toArray();

		for (const table of tableResults) {
			const tableName = table.name as string;
			const columnResults = this.sql
				.exec(`PRAGMA table_info(${tableName})`)
				.toArray();
			const countResult = this.sql
				.exec(`SELECT COUNT(*) as count FROM "${tableName}"`)
				.one();
			const rowCount = Number((countResult as { count: number })?.count || 0);
			totalRows += rowCount;

			tables[tableName] = {
				row_count: rowCount,
				columns: columnResults.map((col: Record<string, unknown>) =>
					buildColumnDescriptor(col, tableName, columnMeta, profileByTable),
				),
			};
		}

		// Extract relationships from inferred schema and attach sample JOIN SQL
		const relationships: TableRelationship[] = inferredSchema
			? this.extractRelationships(inferredSchema)
			: [];
		const relationshipsWithJoins = buildRelationshipJoins(
			relationships,
			inferredSchema,
		);

		// Include provenance metadata if available
		let provenance: ProvenanceRow | undefined;
		try {
			const metaResults = this.sql
				.exec(
					`SELECT name FROM sqlite_master WHERE type='table' AND name = '_staging_metadata'`,
				)
				.toArray();
			if (metaResults.length > 0) {
				const metaRow = this.sql
					.exec(
						`SELECT tool_name, server_name, api_url, staged_at, input_rows, stored_rows, failed_rows FROM _staging_metadata ORDER BY id DESC LIMIT 1`,
					)
					.toArray();
				provenance = normalizeProvenance(metaRow[0]);
			}
		} catch {
			/* best-effort: Ignore — provenance is optional */
		}

		return this.jsonResponse({
			success: true,
			schema: {
				table_count: Object.keys(tables).length,
				total_rows: totalRows,
				tables,
				...(relationshipsWithJoins.length > 0
					? { relationships: relationshipsWithJoins }
					: {}),
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
		const body: RegisterRequestBody = (
			rawRegister !== null && typeof rawRegister === "object" ? rawRegister : {}
		) as RegisterRequestBody;

		if (!body.session_id || !body.data_access_id) {
			return this.jsonResponse(
				{ success: false, error: "session_id and data_access_id are required" },
				400,
			);
		}

		// TTL cleanup: remove entries older than 24h
		this.sql.exec(
			`DELETE FROM _session_registry WHERE created_at < datetime('now', '-24 hours')`,
		);

		this.sql.exec(
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
		const tableExists = this.sql
			.exec(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='_session_registry'`,
			)
			.toArray();
		if (tableExists.length === 0) {
			return this.jsonResponse({ success: true, datasets: [] });
		}

		// TTL cleanup
		this.sql.exec(
			`DELETE FROM _session_registry WHERE created_at < datetime('now', '-24 hours')`,
		);

		if (!sessionId) {
			return this.jsonResponse({ success: true, datasets: [] });
		}

		const rows = this.sql
			.exec(
				`SELECT data_access_id, tool_name, tables_json, total_rows, tool_prefix, created_at FROM _session_registry WHERE session_id = ? ORDER BY created_at DESC`,
				sessionId,
			)
			.toArray();

		const datasets = rows.map((row) => {
			const r = row as unknown as SessionRegistryRow;
			const parsedTables =
				typeof r.tables_json === "string"
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
			this._vfs = new VirtualFS(this.sql);
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
