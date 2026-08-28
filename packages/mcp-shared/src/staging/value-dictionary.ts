/**
 * Value dictionaries for staged columns — what `1`, `2`, `0` actually mean.
 *
 * Staged tables preserve upstream codes verbatim, which is correct but leaves a
 * column of bare integers that no reader can interpret. A dbGaP-style payload
 * says `1 = albuterol, 2 = azithromycin`; once it lands in SQLite that meaning
 * is gone, and a model querying the table can compute over the codes but cannot
 * say what it computed over.
 *
 * Two ways a dictionary gets established, in precedence order:
 *
 * 1. `declared` — the caller passes a mapping taken from an upstream schema
 *    (an OpenAPI enum, a catalog, a dbGaP data dictionary). Authoritative.
 * 2. `paired_column` — inferred from the data: many payloads ship a code column
 *    beside its own label column (`sex` + `sex_label`, `treatmentGroup` +
 *    `treatmentGroupName`). When that pairing is consistent across every row,
 *    the mapping is recoverable without any external schema.
 *
 * Inference is deliberately conservative: one inconsistent row, or a mapping
 * that turns out to be identity, and the column is dropped. A wrong dictionary
 * is worse than none — it would let a model confidently mislabel real data.
 */

/** Suffixes that mark a sibling column as the label for a code column. */
const LABEL_SUFFIXES = [
	"label",
	"name",
	"display",
	"desc",
	"description",
	"text",
	"term",
] as const;

/** Above this many distinct codes a column is free text, not an enumeration. */
const MAX_DICTIONARY_ENTRIES = 200;

export type ValueDictionarySource = "declared" | "paired_column";

export interface ColumnValueDictionary {
	/** Upstream code (as a string) → human-readable label. */
	values: Record<string, string>;
	source: ValueDictionarySource;
	/** For `paired_column`, the sibling column the labels were read from. */
	label_column?: string;
}

/** Column name → dictionary, for one table. */
export type TableValueDictionaries = Record<string, ColumnValueDictionary>;

/** Table name → column dictionaries. */
export type ValueDictionaries = Record<string, TableValueDictionaries>;

export type StagedRow = Record<string, unknown>;

function normalizeColumnName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A code must be a scalar that survives a round-trip through SQLite. */
function asCode(value: unknown): string | undefined {
	if (typeof value === "string") return value.length > 0 ? value : undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return undefined;
}

function asLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Find, for each column, a sibling column that looks like its label.
 * Returns `code column → label column`.
 */
export function findLabelPairs(columns: string[]): Map<string, string> {
	const byNormalized = new Map<string, string>();
	for (const column of columns) {
		byNormalized.set(normalizeColumnName(column), column);
	}
	const pairs = new Map<string, string>();
	for (const column of columns) {
		const base = normalizeColumnName(column);
		for (const suffix of LABEL_SUFFIXES) {
			const candidate = byNormalized.get(`${base}${suffix}`);
			if (candidate !== undefined && candidate !== column) {
				pairs.set(column, candidate);
				break;
			}
		}
	}
	return pairs;
}

interface PairingOutcome {
	values: Record<string, string>;
	consistent: boolean;
}

function collectPairing(
	rows: StagedRow[],
	codeColumn: string,
	labelColumn: string,
): PairingOutcome {
	const values: Record<string, string> = {};
	for (const row of rows) {
		const code = asCode(row[codeColumn]);
		const label = asLabel(row[labelColumn]);
		if (code === undefined || label === undefined) continue;
		const existing = values[code];
		if (existing !== undefined && existing !== label) {
			return { values, consistent: false };
		}
		values[code] = label;
		if (Object.keys(values).length > MAX_DICTIONARY_ENTRIES) {
			return { values, consistent: false };
		}
	}
	return { values, consistent: true };
}

/** A mapping where every label equals its own code teaches a reader nothing. */
function isIdentityMapping(values: Record<string, string>): boolean {
	return Object.entries(values).every(
		([code, label]) => code.toLowerCase() === label.toLowerCase(),
	);
}

/**
 * Infer dictionaries for one table's rows by pairing code columns with their
 * label siblings. Columns that cannot be resolved unambiguously are omitted.
 */
export function inferValueDictionaries(
	rows: StagedRow[],
): TableValueDictionaries {
	if (rows.length === 0) return {};
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	const dictionaries: TableValueDictionaries = {};
	for (const [codeColumn, labelColumn] of findLabelPairs(columns)) {
		const { values, consistent } = collectPairing(
			rows,
			codeColumn,
			labelColumn,
		);
		if (!consistent) continue;
		if (Object.keys(values).length === 0) continue;
		if (isIdentityMapping(values)) continue;
		dictionaries[codeColumn] = {
			values,
			source: "paired_column",
			label_column: labelColumn,
		};
	}
	return dictionaries;
}

/**
 * Merge declared dictionaries over inferred ones. A schema the upstream
 * publishes always beats what we guessed from the rows.
 */
export function mergeValueDictionaries(
	inferred: TableValueDictionaries,
	declared: TableValueDictionaries | undefined,
): TableValueDictionaries {
	if (!declared) return inferred;
	return { ...inferred, ...declared };
}

/** Normalize a caller-supplied mapping into a `declared` dictionary. */
export function declareValueDictionary(
	values: Record<string, string | number>,
): ColumnValueDictionary {
	const normalized: Record<string, string> = {};
	for (const [code, label] of Object.entries(values)) {
		normalized[code] = String(label);
	}
	return { values: normalized, source: "declared" };
}

/** Total number of code→label entries across a table's dictionaries. */
export function countDictionaryEntries(
	dictionaries: TableValueDictionaries,
): number {
	return Object.values(dictionaries).reduce(
		(total, dictionary) => total + Object.keys(dictionary.values).length,
		0,
	);
}
