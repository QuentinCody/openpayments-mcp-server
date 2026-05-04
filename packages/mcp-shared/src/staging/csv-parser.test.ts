/**
 * Co-located smoke tests for the unified CSV parser.
 *
 * The exhaustive suite (numeric heuristic boundaries, embedded newlines,
 * CRLF, leading-zero codes, all-empty rows, scientific notation, oig
 * compatibility, type contracts) lives at:
 *
 *   tests/csv-parser-shared.test.ts
 *
 * Behavior locks for the legacy per-server parsers live at:
 *
 *   tests/csv-parser-characterization.test.ts
 *
 * This file exists so each source unit ships with a directly co-located
 * test file; do not duplicate the exhaustive coverage here.
 */
import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvAsStrings } from "./csv-parser";

describe("csv-parser (smoke)", () => {
    it("parseCsv parses a header + one row, auto-casting numerics", () => {
        expect(parseCsv("a,b\n1,foo")).toEqual([{ a: 1, b: "foo" }]);
    });

    it("parseCsvAsStrings keeps every cell as a string", () => {
        expect(parseCsvAsStrings("a,b\n1,foo")).toEqual([
            { a: "1", b: "foo" },
        ]);
    });

    it("parseCsv handles quoted fields with embedded commas and newlines", () => {
        expect(parseCsv('a,b\n"x, y","line1\nline2"')).toEqual([
            { a: "x, y", b: "line1\nline2" },
        ]);
    });
});
