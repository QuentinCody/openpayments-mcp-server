/**
 * Shared staging-envelope helpers — extracted from api-proxy.ts (which hit the
 * line cap) and deduplicated with graphql-proxy.ts, which carried byte-identical
 * copies. Both the REST (`__api_proxy`) and GraphQL (`__graphql_proxy`) auto-stage
 * paths build the same `{__staged, data_access_id, columns, message, …}` envelope.
 */

import { detectOverMatch, type FilterWarning } from "../completeness";
import type { StageResult } from "../staging/utils";

/** Max size (bytes) for a single property to be preserved in the staging envelope. */
const ENVELOPE_SCALAR_LIMIT = 1024;

/**
 * Copy small scalar properties from the original API response onto the staging
 * metadata object. This preserves values like `.count`, `.total`, `.schema`,
 * `.paging_info` so LLM code can read them without an extra round-trip
 * (ADR-004 Option C). Never clobbers an existing envelope field.
 */
export function preserveEnvelopeScalars(
	original: unknown,
	staging: Record<string, unknown>,
): void {
	if (!original || typeof original !== "object" || Array.isArray(original)) {
		return;
	}
	// After the typeof guard, Object.entries is safe on the narrowed `object` type.
	for (const [key, value] of Object.entries(original)) {
		if (key in staging) continue; // don't clobber staging metadata fields
		try {
			const serialized = JSON.stringify(value);
			if (
				serialized !== undefined &&
				serialized.length <= ENVELOPE_SCALAR_LIMIT
			) {
				staging[key] = value;
			}
		} catch {
			/* best-effort: Skip non-serializable values */
		}
	}
}

/**
 * Compact `{ table: [col, …] }` map extracted from a staged dataset's schema.
 *
 * Surfaced on the staging envelope (T3.3) so the model learns the staged column
 * names from the SAME response that staged the data — no PRAGMA / sqlite_master
 * round-trip, and no column-name guessing (the recurring `no such column: NCTId`
 * failure where staging snake_cases the API field). Returns undefined when the
 * schema carries no recognizable tables.
 */
export function extractStagedColumns(
	schema: unknown,
): Record<string, string[]> | undefined {
	const tables = (
		schema as
			| { tables?: Record<string, { columns?: Array<{ name?: unknown }> }> }
			| null
			| undefined
	)?.tables;
	if (!tables || typeof tables !== "object") return undefined;
	const out: Record<string, string[]> = {};
	for (const [tableName, info] of Object.entries(tables)) {
		const cols = Array.isArray(info?.columns)
			? info.columns.map((c) => String(c?.name ?? "")).filter(Boolean)
			: [];
		if (cols.length > 0) out[tableName] = cols;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build a human-readable summary of staged tables for the message field.
 * Example: "2 tables: transcript [10 rows], transcript_Exon [271 rows]"
 */
export function buildStagedTableSummary(staged: StageResult): string {
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

export interface StagedEnvelopeInput {
	staged: StageResult;
	responseBytes: number;
	/** The original upstream payload — small scalar siblings are preserved onto the
	 *  envelope, and (unless `overMatch` is supplied) it is scanned for a silent
	 *  over-match (Finding #2 / T1.3). */
	originalData: unknown;
	/** Pre-computed over-match warning; defaults to detectOverMatch(originalData). */
	overMatch?: FilterWarning;
}

/**
 * Build the standard auto-stage response envelope, shared by the REST and GraphQL
 * proxies. Carries `columns` (T3.3), an `INCOMPLETE` note when the staged set is
 * under-counted (completeness), a `filter_warning` when the upstream filter
 * silently over-matched (T1.3), and the preserved scalar siblings of the payload.
 */
export function buildStagedEnvelope(
	input: StagedEnvelopeInput,
): Record<string, unknown> {
	const { staged, responseBytes, originalData } = input;
	const overMatch = input.overMatch ?? detectOverMatch(originalData);
	const tableDetail = buildStagedTableSummary(staged);
	const completeness = staged._staging?.completeness;
	const incompleteNote =
		completeness && completeness.complete === false
			? ` INCOMPLETE: ${completeness.truncation?.detail ?? ""} ${completeness.truncation?.remedy ?? ""}`.trimEnd()
			: "";
	const filterNote = overMatch ? ` ⚠ ${overMatch.detail}` : "";
	const stagedCols = extractStagedColumns(staged.schema);
	const response: Record<string, unknown> = {
		__staged: true,
		data_access_id: staged.dataAccessId,
		schema: staged.schema,
		tables_created: staged.tablesCreated,
		total_rows: staged.totalRows,
		_staging: staged._staging,
		...(stagedCols ? { columns: stagedCols } : {}),
		...(staged.stagingWarnings
			? { staging_warnings: staged.stagingWarnings }
			: {}),
		...(overMatch ? { filter_warning: overMatch } : {}),
		message: `Response auto-staged (${(responseBytes / 1024).toFixed(1)}KB → ${tableDetail}). Columns are in the "columns" field. Use api.query("${staged.dataAccessId}", sql) in-band, or return this object for the caller to use the query_data tool.${incompleteNote}${filterNote}`,
	};
	preserveEnvelopeScalars(originalData, response);
	return response;
}
