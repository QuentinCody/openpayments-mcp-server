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
	type InferredSchema,
	type SchemaHints,
} from "./schema-inference";
import { stageData } from "./staging-engine";
import type { DomainConfig, StagingContext, StagingHints } from "./types";
import type { TableRelationship } from "./staging-metadata";

export class RestStagingDO extends DurableObject {
	protected chunking = new ChunkingEngine();

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
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS _inferred_schema (
					id INTEGER PRIMARY KEY,
					schema_json TEXT
				)`,
			);
			this.ctx.storage.sql.exec(
				`INSERT OR REPLACE INTO _inferred_schema (id, schema_json) VALUES (1, ?)`,
				JSON.stringify(schema),
			);
		} catch {
			// Non-critical — schema still works via PRAGMA, just without enrichment
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
		const json = (await request.json()) as unknown;
		const container = (json as Record<string, unknown>) || {};
		const data = (container as { data?: unknown }).data ?? json;

		// Extract provenance context from request body
		const stagingContext = (container as { context?: Record<string, unknown> }).context;
		this.storeProvenance(stagingContext as {
			toolName?: string;
			serverName?: string;
			args?: Record<string, unknown>;
			apiUrl?: string;
		});

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

		// Legacy Tier 1 pipeline
		const hints = this.getSchemaHints(data);
		const arrays = detectArrays(data);

		if (arrays.length > 0 && arrays.some((a) => a.rows.length > 0)) {
			const schema = inferSchema(arrays, hints);

			// Persist inferred schema for enriched handleSchema() output
			this.persistInferredSchema(schema);

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
		const body = (await request.json()) as { sql: string };
		const res = this.ctx.storage.sql.exec(body.sql);
		const results = res.toArray();
		return this.jsonResponse({
			success: true,
			results,
			row_count: results.length,
		});
	}

	private async handleQueryEnhanced(request: Request): Promise<Response> {
		const body = (await request.json()) as { sql: string };
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
		return this.jsonResponse({
			success: true,
			results: enhanced,
			row_count: enhanced.length,
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

		const tableResults = this.ctx.storage.sql
			.exec(
				`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_staging_%' AND name != '_inferred_schema'`,
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
					return {
						name: colName,
						type: col.type as string,
						not_null: col.notnull === 1,
						primary_key: col.pk === 1,
						...(meta?.jsonShape ? { json_shape: meta.jsonShape } : {}),
						...(meta?.pipeDelimited ? { searchable_array: true } : {}),
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
		let provenance: Record<string, unknown> | undefined;
		try {
			const metaResults = this.ctx.storage.sql
				.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name = '_staging_metadata'`)
				.toArray();
			if (metaResults.length > 0) {
				const metaRow = this.ctx.storage.sql
					.exec(`SELECT tool_name, server_name, api_url, staged_at, input_rows, stored_rows, failed_rows FROM _staging_metadata ORDER BY id DESC LIMIT 1`)
					.toArray();
				if (metaRow.length > 0) {
					provenance = metaRow[0] as Record<string, unknown>;
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
		const body = (await request.json()) as {
			session_id: string;
			data_access_id: string;
			tool_name?: string;
			tables?: string[];
			total_rows?: number;
			tool_prefix?: string;
		};

		if (!body.session_id || !body.data_access_id) {
			return this.jsonResponse(
				{ success: false, error: "session_id and data_access_id are required" },
				400,
			);
		}

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

		const datasets = rows.map((row: Record<string, unknown>) => ({
			data_access_id: row.data_access_id as string,
			tool_name: row.tool_name as string | null,
			tables: row.tables_json ? JSON.parse(row.tables_json as string) : [],
			total_rows: row.total_rows as number | null,
			tool_prefix: row.tool_prefix as string | null,
			created_at: row.created_at as string,
		}));

		return this.jsonResponse({ success: true, datasets });
	}

	private jsonResponse(data: unknown, status = 200): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}
}
