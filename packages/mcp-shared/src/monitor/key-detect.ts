/**
 * Monitoring primitive — business-key auto-detection.
 *
 * When a subscription does not declare an explicit key, infer a single-column
 * business key from per-column statistics: a column unique across all rows
 * (distinctCount === rowCount) and never null. Prefers a known bio-id column
 * name. Returns null when no column is a clean unique key — the caller then
 * falls back to hashing the whole canonicalized row.
 *
 * This deliberately excludes the staging synthetic PK (`_rowid`): it is unique
 * but insertion-order, so keying on it would report churn on every reorder.
 */

/** Per-column cardinality stats (mapped from staging get_schema column profiles). */
export interface KeyColumnStat {
	column: string;
	distinctCount: number;
	nullCount: number;
	rowCount: number;
}

/** Column names that strongly signal a natural business key in bio/biomed data. */
const KEY_HINTS = new Set([
	"id",
	"nct_id",
	"gene_symbol",
	"rsid",
	"variant_id",
	"accession",
	"drug_name",
	"appl_no",
	"patent_no",
	"uniprot",
	"ensembl_id",
	"doi",
	"pmid",
	"chembl_id",
	"hgvs",
	"code",
]);

/** Infer a single-column business key, or null if none is a clean unique key. */
export function autoDetectKey(stats: KeyColumnStat[]): string[] | null {
	const unique = stats.filter(
		(s) =>
			s.rowCount > 0 &&
			s.distinctCount === s.rowCount &&
			s.nullCount === 0 &&
			s.column !== "_rowid",
	);
	if (unique.length === 0) return null;
	const hinted = unique.find((s) => KEY_HINTS.has(s.column.toLowerCase()));
	return [(hinted ?? unique[0]).column];
}
