/**
 * Hidden __sparql_proxy tool — routes V8 isolate sparql.query() calls
 * through the server's SPARQL fetch function.
 *
 * Only callable from V8 isolates (hidden=true). Auto-stages large responses.
 */

import { z } from "zod";
import type { ToolEntry } from "../registry/types";
import type { SparqlFetchFn } from "../codemode/sparql-introspection";
import { shouldStage, stageToDoAndRespond, type StageResult } from "../staging/utils";

const ENVELOPE_SCALAR_LIMIT = 1024;

function preserveEnvelopeScalars(
	original: unknown,
	staging: Record<string, unknown>,
): void {
	if (!original || typeof original !== "object" || Array.isArray(original)) return;
	for (const [key, value] of Object.entries(original)) {
		if (key in staging) continue;
		try {
			const serialized = JSON.stringify(value);
			if (serialized !== undefined && serialized.length <= ENVELOPE_SCALAR_LIMIT) {
				staging[key] = value;
			}
		} catch { /* best-effort: non-serializable */ }
	}
}

function buildStagedTableSummary(staged: StageResult): string {
	const tables = staged.tablesCreated;
	const rowCounts = staged._staging?.table_row_counts as
		| Record<string, number>
		| undefined;
	if (!tables || tables.length === 0) {
		return `${staged.totalRows ?? 0} rows`;
	}
	if (tables.length === 1) {
		const rows = rowCounts?.[tables[0]] ?? staged.totalRows ?? 0;
		return `table "${tables[0]}" [${rows} rows]`;
	}
	const details = tables
		.map((t) => {
			const rows = rowCounts?.[t];
			return rows !== undefined ? `${t} [${rows}]` : t;
		})
		.join(", ");
	return `${tables.length} tables: ${details}`;
}

export interface SparqlProxyToolOptions {
	sparqlFetch: SparqlFetchFn;
	doNamespace?: unknown;
	stagingPrefix: string;
	stagingThreshold?: number;
}

interface StagingConfig {
	doNamespace: unknown;
	prefix: string;
	threshold: number | undefined;
}

type SparqlBinding = Record<
	string,
	{ value: string; type?: string; datatype?: string; "xml:lang"?: string }
>;

interface ParsedSparqlEnvelope {
	/** Virtuoso / SPARQL 1.1 JSON results shape */
	head?: { vars?: string[]; link?: string[] };
	results?: { bindings?: SparqlBinding[] };
	/** ASK queries return { head: {}, boolean: true|false } */
	boolean?: boolean;
	[k: string]: unknown;
}

/**
 * Flatten a SPARQL 1.1 JSON results envelope into row-shaped data for the
 * staging engine. Bindings live at `results.bindings[]` (NOT top-level
 * `bindings`); the staging engine's schema-inference v2 then produces one
 * table with one column per SELECT variable.
 *
 * ASK queries (boolean) and CONSTRUCT/DESCRIBE (non-bindings) fall through
 * unchanged — the staging engine handles them as-is.
 */
function shapeForStaging(parsed: ParsedSparqlEnvelope): unknown {
	const bindings = parsed?.results?.bindings;
	if (Array.isArray(bindings)) {
		return bindings.map((b) => {
			const row: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(b)) {
				row[k] = v?.value ?? null;
			}
			return row;
		});
	}
	return parsed;
}

async function tryAutoStage(
	envelope: ParsedSparqlEnvelope,
	config: StagingConfig,
	sessionId: string | undefined,
): Promise<Record<string, unknown> | undefined> {
	const stageable = shapeForStaging(envelope);
	const responseBytes = JSON.stringify(stageable).length;
	if (!config.doNamespace || !shouldStage(responseBytes, config.threshold)) {
		return undefined;
	}

	const staged = await stageToDoAndRespond(
		stageable,
		config.doNamespace as Parameters<typeof stageToDoAndRespond>[1],
		config.prefix,
		undefined,
		undefined,
		config.prefix,
		sessionId,
	);
	const tableDetail = buildStagedTableSummary(staged);
	const wrapper: Record<string, unknown> = {
		__staged: true,
		data_access_id: staged.dataAccessId,
		schema: staged.schema,
		tables_created: staged.tablesCreated,
		total_rows: staged.totalRows,
		_staging: staged._staging,
		message: `SPARQL response auto-staged (${(responseBytes / 1024).toFixed(1)}KB → ${tableDetail}). Use api.query("${staged.dataAccessId}", sql) in-band, or return this object for the caller to use the query_data tool.`,
	};
	preserveEnvelopeScalars(envelope, wrapper);
	return wrapper;
}

async function executeAndMaybeStage(
	sparqlFetch: SparqlFetchFn,
	query: string,
	method: "GET" | "POST",
	format: string,
	timeoutMs: number,
	staging: StagingConfig,
	sessionId: string | undefined,
): Promise<unknown> {
	const raw = (await sparqlFetch(query, { method, format, timeoutMs })) as ParsedSparqlEnvelope;
	const wrapper = await tryAutoStage(raw, staging, sessionId);
	return wrapper ?? raw;
}

export function createSparqlProxyTool(options: SparqlProxyToolOptions): ToolEntry {
	const staging: StagingConfig = {
		doNamespace: options.doNamespace,
		prefix: options.stagingPrefix,
		threshold: options.stagingThreshold,
	};

	return {
		name: "__sparql_proxy",
		description: "Route SPARQL queries from V8 isolate through server fetch layer. Internal only.",
		hidden: true,
		schema: {
			query: z.string(),
			method: z.enum(["GET", "POST"]).optional(),
			format: z.string().optional(),
			timeoutMs: z.number().optional(),
		},
		handler: async (input, ctx) => {
			const query = String(input.query || "");
			if (!query) {
				return { __sparql_error: true, code: "invalid_input", message: "query is required" };
			}
			const method = (input.method as "GET" | "POST" | undefined) ?? "POST";
			const format = (input.format as string | undefined) ?? "json";
			const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 60_000;
			try {
				return await executeAndMaybeStage(
					options.sparqlFetch,
					query,
					method,
					format,
					timeoutMs,
					staging,
					ctx?.sessionId,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { __sparql_error: true, code: "execution_error", message };
			}
		},
	};
}
