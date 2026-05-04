/**
 * Wide-matrix → long-form pivot for genomic CSVs (DepMap, PedDep, GTEx
 * bulk, any "rows = genes, cols = samples" matrix).
 *
 * SQLite caps tables at 2k columns; DepMap matrices ship as
 * ~18k genes × ~1k cell lines. This helper melts the wide form into
 * row-per-(gene, cell_line, value) tuples that fit a normal staging
 * table layout.
 *
 * Gene resolution (symbol → entrez) is delegated to a {@link GeneResolver}
 * — production wires this to MyGene.info via
 * `@bio-mcp/shared/biothings/gene-resolver`. Tests pass a fake.
 */

import type { GeneResolver } from "../biothings/gene-resolver";

export interface LongFormRow {
    readonly entrez_id: number | null;
    readonly gene_symbol: string;
    readonly cell_line_id: string;
    readonly value: number | null;
}

export interface PivotLongFormOptions {
    /** Header name of the column carrying gene identifiers. */
    readonly geneColumn: string;
    /** Headers of the columns to melt — typically the cell-line IDs. */
    readonly cellLineColumns: readonly string[];
    /** Optional gene resolver; omit for entrez_id: null on every row. */
    readonly resolveGene?: GeneResolver;
    /**
     * String values that should melt to {@link LongFormRow.value} = null.
     * Default: ["NA", "NaN", "", "null"].
     */
    readonly nullSentinels?: readonly string[];
}

const DEFAULT_NULL_SENTINELS: readonly string[] = ["NA", "NaN", "", "null"];

/**
 * Coerce a wide-matrix cell value into a long-form numeric value or null.
 * Numeric strings parse to numbers; sentinel strings (and JS NaN) → null.
 */
function coerceCell(
    raw: unknown,
    nullSentinelsLower: ReadonlySet<string>,
): number | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") {
        return Number.isFinite(raw) ? raw : null;
    }
    const s = String(raw).trim();
    if (nullSentinelsLower.has(s.toLowerCase())) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * Pivot wide rows (one row per gene, one column per cell line) into
 * long-form rows (one row per gene × cell line pair).
 */
export async function pivotLongForm(
    rows: readonly Record<string, unknown>[],
    options: PivotLongFormOptions,
): Promise<LongFormRow[]> {
    const {
        geneColumn,
        cellLineColumns,
        resolveGene,
        nullSentinels = DEFAULT_NULL_SENTINELS,
    } = options;

    const nullSentinelsLower = new Set(
        nullSentinels.map((s) => s.toLowerCase()),
    );

    // Collect distinct gene symbols up front so the resolver gets one
    // batched call regardless of duplicates in the input matrix.
    const distinctSymbols: string[] = [];
    const seenSymbols = new Set<string>();
    for (const row of rows) {
        const sym = row[geneColumn];
        if (typeof sym !== "string" || sym === "") continue;
        if (!seenSymbols.has(sym)) {
            seenSymbols.add(sym);
            distinctSymbols.push(sym);
        }
    }

    const symbolToEntrez = new Map<string, number | null>();
    if (resolveGene && distinctSymbols.length > 0) {
        const resolved = await resolveGene(distinctSymbols);
        for (const sym of distinctSymbols) {
            const hit = resolved.get(sym);
            symbolToEntrez.set(
                sym,
                hit?.found && typeof hit.entrezgene === "number"
                    ? hit.entrezgene
                    : null,
            );
        }
    }

    const out: LongFormRow[] = [];
    for (const row of rows) {
        const sym = row[geneColumn];
        if (typeof sym !== "string" || sym === "") continue;
        const entrezId = symbolToEntrez.get(sym) ?? null;
        for (const cellLineId of cellLineColumns) {
            const value = coerceCell(row[cellLineId], nullSentinelsLower);
            out.push({
                entrez_id: entrezId,
                gene_symbol: sym,
                cell_line_id: cellLineId,
                value,
            });
        }
    }
    return out;
}
