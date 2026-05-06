/**
 * Variable-precision date parser.
 *
 * Many biomedical APIs emit dates with varying precision:
 *   - FHIR: "2024", "2024-03", "2024-03-15", "2024-03-15T12:34:56Z"
 *   - PubMed: "2024", "2024 May", "2024 May 15"
 *   - ChEMBL: just year_of_publication
 *   - ClinicalTrials.gov: start_date with date_struct{year,month,day} all optional
 *   - NIH RePORTER: fiscal years
 *
 * Storing these as raw strings loses SQL `ORDER BY` correctness because lexical
 * sort drifts (`"2024-3-1"` < `"2024-03"` lexically). This module produces
 * two paired values:
 *   - `iso`: a normalized ISO-8601 prefix (truncated at the precision boundary)
 *   - `precision`: integer 0-4 (NONE/YEAR/MONTH/DAY/TIME)
 *
 * Callers can store both and `ORDER BY iso ASC` correctly across mixed-precision
 * rows. The original string is returned in `raw` for round-trip preservation.
 *
 * Pattern derived from shc-web-reader/src/lib/fhirUtil.js:189-230 (MIT © 2023
 * The Commons Project) with extensions for non-FHIR date conventions.
 *
 * IMPORTANT: This is a stateless utility. The shared schema-inference engine
 * does NOT auto-apply it. Servers opt in by calling `parseVariablePrecisionDate`
 * in their resource enrichment step.
 */

export const PRECISION_NONE = 0;
export const PRECISION_YEAR = 1;
export const PRECISION_MONTH = 2;
export const PRECISION_DAY = 3;
export const PRECISION_TIME = 4;

export type DatePrecision =
	| typeof PRECISION_NONE
	| typeof PRECISION_YEAR
	| typeof PRECISION_MONTH
	| typeof PRECISION_DAY
	| typeof PRECISION_TIME;

export interface ParsedVariablePrecisionDate {
	/** Normalized ISO-8601 prefix, truncated at the precision boundary. Empty when invalid. */
	iso: string;
	/** Precision granularity of the source. */
	precision: DatePrecision;
	/** Original input, unmodified. */
	raw: string;
	/** True when the input was recognizable. */
	valid: boolean;
}

const ISO_DATE_ONLY_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

const PUBMED_MONTH_NAMES: Record<string, string> = {
	jan: "01",
	feb: "02",
	mar: "03",
	apr: "04",
	may: "05",
	jun: "06",
	jul: "07",
	aug: "08",
	sep: "09",
	sept: "09",
	oct: "10",
	nov: "11",
	dec: "12",
};
const PUBMED_RE = /^(\d{4})(?:\s+([A-Za-z]+)(?:\s+(\d{1,2}))?)?$/;

/**
 * Parse a date string of variable precision into a normalized ISO prefix and
 * precision indicator.
 *
 * Returns `{iso: "", precision: PRECISION_NONE, valid: false}` on unrecognized input.
 */
export function parseVariablePrecisionDate(input: unknown): ParsedVariablePrecisionDate {
	if (typeof input !== "string" || input.length === 0) {
		return { iso: "", precision: PRECISION_NONE, raw: String(input ?? ""), valid: false };
	}
	const raw = input.trim();
	if (!raw) {
		return { iso: "", precision: PRECISION_NONE, raw: input, valid: false };
	}

	// FHIR / ISO date-only forms: YYYY, YYYY-MM, YYYY-MM-DD
	if (ISO_DATE_ONLY_RE.test(raw)) {
		const parts = raw.split("-");
		if (parts.length === 1) {
			return { iso: parts[0], precision: PRECISION_YEAR, raw: input, valid: true };
		}
		if (parts.length === 2) {
			return {
				iso: `${parts[0]}-${parts[1]}`,
				precision: PRECISION_MONTH,
				raw: input,
				valid: true,
			};
		}
		return {
			iso: `${parts[0]}-${parts[1]}-${parts[2]}`,
			precision: PRECISION_DAY,
			raw: input,
			valid: true,
		};
	}

	// FHIR full instant or any string with 'T' — let JS parser handle it.
	if (raw.includes("T") || raw.includes("Z") || raw.includes("+") || /\d{2}:\d{2}/.test(raw)) {
		const dt = new Date(raw);
		if (!isNaN(dt.getTime())) {
			return {
				iso: dt.toISOString(),
				precision: PRECISION_TIME,
				raw: input,
				valid: true,
			};
		}
	}

	// PubMed-style: "2024 May", "2024 May 15", "2024 Sept 1"
	const pubmed = PUBMED_RE.exec(raw);
	if (pubmed) {
		const [, year, monthName, day] = pubmed;
		if (monthName) {
			const monthCode = PUBMED_MONTH_NAMES[monthName.toLowerCase().slice(0, 4).replace(/[^a-z]/g, "")] ??
				PUBMED_MONTH_NAMES[monthName.toLowerCase().slice(0, 3)];
			if (monthCode) {
				if (day) {
					const dd = day.padStart(2, "0");
					return {
						iso: `${year}-${monthCode}-${dd}`,
						precision: PRECISION_DAY,
						raw: input,
						valid: true,
					};
				}
				return {
					iso: `${year}-${monthCode}`,
					precision: PRECISION_MONTH,
					raw: input,
					valid: true,
				};
			}
		}
		return { iso: year, precision: PRECISION_YEAR, raw: input, valid: true };
	}

	// Bare 4-digit year, possibly with extra whitespace.
	if (/^\d{4}$/.test(raw)) {
		return { iso: raw, precision: PRECISION_YEAR, raw: input, valid: true };
	}

	// Fallback: try Date parser.
	const dt = new Date(raw);
	if (!isNaN(dt.getTime())) {
		return {
			iso: dt.toISOString(),
			precision: PRECISION_TIME,
			raw: input,
			valid: true,
		};
	}

	return { iso: "", precision: PRECISION_NONE, raw: input, valid: false };
}

/**
 * Derive the column-pair name convention for a given source field.
 *
 * Servers opting in produce two SQL columns:
 *   - `<field>_iso`      TEXT  — sortable normalized ISO prefix
 *   - `<field>_precision` INTEGER — see PRECISION_* constants
 *
 * The original field stays as a TEXT column with the raw input for round-tripping.
 */
export function variablePrecisionColumnNames(field: string): {
	iso: string;
	precision: string;
} {
	return {
		iso: `${field}_iso`,
		precision: `${field}_precision`,
	};
}

/**
 * Convenience: enrich an object by adding `<field>_iso` and `<field>_precision`
 * paired columns alongside an existing date field. Returns the enriched object
 * (does not mutate). Skips fields with unparseable values.
 *
 * @example
 *   enrichWithVariablePrecisionDate(observation, "effectiveDateTime")
 *   //   { effectiveDateTime: "2024-03", effectiveDateTime_iso: "2024-03",
 *   //     effectiveDateTime_precision: 2, ... }
 */
export function enrichWithVariablePrecisionDate<T extends Record<string, unknown>>(
	obj: T,
	field: string,
): T {
	const value = obj[field];
	if (typeof value !== "string") return obj;
	const parsed = parseVariablePrecisionDate(value);
	if (!parsed.valid) return obj;
	const cols = variablePrecisionColumnNames(field);
	return { ...obj, [cols.iso]: parsed.iso, [cols.precision]: parsed.precision };
}
