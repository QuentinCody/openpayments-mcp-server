/**
 * Co-located smoke tests for the wide-matrix pivot helper.
 *
 * The exhaustive suite (NA sentinels, batched resolver calls, no-resolver
 * fallback, PedDep cohort fixture) lives at:
 *
 *   tests/csv-pivot-depmap.test.ts
 *
 * Keep this file minimal — proves the public surface only.
 */
import { describe, expect, it } from "vitest";
import { pivotLongForm } from "./csv-pivot";

describe("pivotLongForm (smoke)", () => {
    it("melts a single-row, single-column matrix to one long-form row", async () => {
        const out = await pivotLongForm(
            [{ gene: "TP53", "ACH-001": "1.5" }],
            {
                geneColumn: "gene",
                cellLineColumns: ["ACH-001"],
            },
        );
        expect(out).toEqual([
            {
                entrez_id: null,
                gene_symbol: "TP53",
                cell_line_id: "ACH-001",
                value: 1.5,
            },
        ]);
    });
});
