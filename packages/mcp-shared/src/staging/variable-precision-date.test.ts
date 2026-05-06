import { describe, expect, it } from "vitest";

import {
	PRECISION_DAY,
	PRECISION_MONTH,
	PRECISION_NONE,
	PRECISION_TIME,
	PRECISION_YEAR,
	enrichWithVariablePrecisionDate,
	parseVariablePrecisionDate,
	variablePrecisionColumnNames,
} from "./variable-precision-date";

describe("parseVariablePrecisionDate — FHIR/ISO forms", () => {
	it("year only → PRECISION_YEAR", () => {
		const r = parseVariablePrecisionDate("2024");
		expect(r.valid).toBe(true);
		expect(r.iso).toBe("2024");
		expect(r.precision).toBe(PRECISION_YEAR);
	});

	it("year-month → PRECISION_MONTH", () => {
		const r = parseVariablePrecisionDate("2024-03");
		expect(r.iso).toBe("2024-03");
		expect(r.precision).toBe(PRECISION_MONTH);
	});

	it("year-month-day → PRECISION_DAY", () => {
		const r = parseVariablePrecisionDate("2024-03-15");
		expect(r.iso).toBe("2024-03-15");
		expect(r.precision).toBe(PRECISION_DAY);
	});

	it("ISO instant → PRECISION_TIME", () => {
		const r = parseVariablePrecisionDate("2024-03-15T12:34:56Z");
		expect(r.precision).toBe(PRECISION_TIME);
		expect(r.iso.startsWith("2024-03-15T")).toBe(true);
		expect(r.iso.endsWith("Z")).toBe(true);
	});

	it("ISO with offset → PRECISION_TIME", () => {
		const r = parseVariablePrecisionDate("2024-03-15T12:34:56-05:00");
		expect(r.precision).toBe(PRECISION_TIME);
		expect(r.valid).toBe(true);
	});
});

describe("parseVariablePrecisionDate — PubMed forms", () => {
	it("'2024 May 15' → PRECISION_DAY", () => {
		const r = parseVariablePrecisionDate("2024 May 15");
		expect(r.valid).toBe(true);
		expect(r.iso).toBe("2024-05-15");
		expect(r.precision).toBe(PRECISION_DAY);
	});

	it("'2024 May' → PRECISION_MONTH", () => {
		const r = parseVariablePrecisionDate("2024 May");
		expect(r.iso).toBe("2024-05");
		expect(r.precision).toBe(PRECISION_MONTH);
	});

	it("'2024 Sept 1' (4-letter abbrev) → PRECISION_DAY", () => {
		const r = parseVariablePrecisionDate("2024 Sept 1");
		expect(r.iso).toBe("2024-09-01");
		expect(r.precision).toBe(PRECISION_DAY);
	});

	it("'2024 Jul 4' single-digit day pads correctly", () => {
		const r = parseVariablePrecisionDate("2024 Jul 4");
		expect(r.iso).toBe("2024-07-04");
	});
});

describe("parseVariablePrecisionDate — degenerate inputs", () => {
	it("empty string → invalid", () => {
		const r = parseVariablePrecisionDate("");
		expect(r.valid).toBe(false);
		expect(r.precision).toBe(PRECISION_NONE);
	});

	it("non-string → invalid", () => {
		const r = parseVariablePrecisionDate(undefined);
		expect(r.valid).toBe(false);
	});

	it("nonsense → invalid", () => {
		const r = parseVariablePrecisionDate("not a date");
		expect(r.valid).toBe(false);
	});

	it("preserves the raw input", () => {
		const r = parseVariablePrecisionDate("  2024-03  ");
		expect(r.raw).toBe("  2024-03  ");
	});
});

describe("variablePrecisionColumnNames", () => {
	it("returns the conventional column names", () => {
		const cols = variablePrecisionColumnNames("effectiveDateTime");
		expect(cols.iso).toBe("effectiveDateTime_iso");
		expect(cols.precision).toBe("effectiveDateTime_precision");
	});
});

describe("enrichWithVariablePrecisionDate", () => {
	it("adds *_iso and *_precision", () => {
		const obj: Record<string, unknown> = { effectiveDateTime: "2024-03" };
		const enriched = enrichWithVariablePrecisionDate(obj, "effectiveDateTime");
		expect(enriched.effectiveDateTime_iso).toBe("2024-03");
		expect(enriched.effectiveDateTime_precision).toBe(PRECISION_MONTH);
	});

	it("does not mutate the original", () => {
		const obj: Record<string, unknown> = { onsetDateTime: "2024-03-15" };
		const enriched = enrichWithVariablePrecisionDate(obj, "onsetDateTime");
		expect(enriched).not.toBe(obj);
		expect("onsetDateTime_iso" in obj).toBe(false);
	});

	it("returns input unchanged when field absent or unparseable", () => {
		const obj: Record<string, unknown> = { other: "x" };
		const enriched = enrichWithVariablePrecisionDate(obj, "missingField");
		expect(enriched).toBe(obj);
	});
});

describe("ORDER BY correctness across mixed precision", () => {
	it("ISO prefixes sort correctly across YEAR/MONTH/DAY/TIME", () => {
		const dates = ["2024", "2024-03", "2024-03-15", "2024-03-15T12:34:56Z", "2025"];
		const isos = dates.map((d) => parseVariablePrecisionDate(d).iso);
		const sorted = [...isos].sort();
		expect(sorted).toEqual(isos);
	});
});
