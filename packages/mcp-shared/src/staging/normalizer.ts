/**
 * Shared string normalization utilities for JSON → SQLite conversion.
 *
 * Extracted from 6 per-server copies into a single source of truth.
 * All functions are pure (no state) and deterministic.
 */

import type { DomainConfig } from "./types";

// ---------------------------------------------------------------------------
// SQL reserved words
// ---------------------------------------------------------------------------

const TABLE_RESERVED_WORDS = new Set([
	"table",
	"index",
	"view",
	"column",
	"primary",
	"key",
	"foreign",
	"constraint",
]);

const COLUMN_RESERVED_WORDS = new Set([
	"table",
	"index",
	"view",
	"column",
	"primary",
	"key",
	"foreign",
	"constraint",
	"order",
	"group",
	"select",
	"from",
	"where",
]);

// ---------------------------------------------------------------------------
// Singularization exceptions (common across biology domains)
// ---------------------------------------------------------------------------

const DEFAULT_SINGULAR_EXCEPTIONS = new Set([
	"genus",
	"species",
	"series",
	"analysis",
	"basis",
	"axis",
	"status",
	"alias",
	"atlas",
	"consensus",
	"corpus",
]);

// ---------------------------------------------------------------------------
// sanitizeTableName
// ---------------------------------------------------------------------------

export function sanitizeTableName(name: string): string {
	if (!name || typeof name !== "string") {
		return "table_" + randomSuffix();
	}

	let sanitized = name
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^_|_$/g, "")
		.toLowerCase();

	if (/^[0-9]/.test(sanitized)) {
		sanitized = "table_" + sanitized;
	}

	if (!sanitized || sanitized.length === 0) {
		sanitized = "table_" + randomSuffix();
	}

	if (TABLE_RESERVED_WORDS.has(sanitized)) {
		sanitized = sanitized + "_table";
	}

	return sanitized;
}

// ---------------------------------------------------------------------------
// sanitizeColumnName
// ---------------------------------------------------------------------------

export function sanitizeColumnName(
	name: string,
	config?: DomainConfig,
): string {
	if (!name || typeof name !== "string") {
		return "column_" + randomSuffix();
	}

	// Apply semantic mappings first (RCSB-PDB style)
	let colName = name;
	if (config?.semanticMappings) {
		const lower = colName.toLowerCase();
		const mapped =
			config.semanticMappings[lower] ?? config.semanticMappings[colName];
		if (mapped) {
			colName = mapped;
		}
	}

	// Convert camelCase to snake_case
	let snakeCase = colName
		.replace(/([A-Z])/g, "_$1")
		.toLowerCase()
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^_|_$/g, "");

	if (/^[0-9]/.test(snakeCase)) {
		snakeCase = "col_" + snakeCase;
	}

	if (!snakeCase || snakeCase.length === 0) {
		snakeCase = "column_" + randomSuffix();
	}

	// Apply domain-specific column name mappings
	if (config?.columnNameMappings) {
		snakeCase = config.columnNameMappings[snakeCase] ?? snakeCase;
	}

	if (COLUMN_RESERVED_WORDS.has(snakeCase)) {
		return snakeCase + "_col";
	}

	return snakeCase;
}

// ---------------------------------------------------------------------------
// singularize
// ---------------------------------------------------------------------------

export function singularize(word: string, config?: DomainConfig): string {
	const sanitized = sanitizeTableName(word);
	const exceptions = config?.singularizationExceptions
		? new Set([
				...DEFAULT_SINGULAR_EXCEPTIONS,
				...config.singularizationExceptions,
			])
		: DEFAULT_SINGULAR_EXCEPTIONS;

	if (exceptions.has(sanitized)) return sanitized;

	// -ies → -y  (e.g. "therapies" → "therapy")
	if (sanitized.endsWith("ies") && sanitized.length > 4) {
		return sanitized.slice(0, -3) + "y";
	}
	// -ves → -f  (e.g. "halves" → "half")
	if (sanitized.endsWith("ves") && sanitized.length > 4) {
		return sanitized.slice(0, -3) + "f";
	}
	// -ses → -se (only for words like "responses" → "response", NOT "diseases")
	// Targeted to avoid mis-singularizing words where "-ses" is part of the stem.
	if (sanitized.endsWith("nses") && sanitized.length > 5) {
		return sanitized.slice(0, -1); // "responses" → "response"
	}
	// -s → remove (but not -ss)
	if (
		sanitized.endsWith("s") &&
		!sanitized.endsWith("ss") &&
		sanitized.length > 2
	) {
		const candidate = sanitized.slice(0, -1);
		if (candidate.length > 1) return candidate;
	}

	return sanitized;
}

// ---------------------------------------------------------------------------
// getSQLiteType
// ---------------------------------------------------------------------------

export function getSQLiteType(value: unknown): string {
	if (value === null || value === undefined) return "TEXT";
	switch (typeof value) {
		case "number":
			return Number.isInteger(value) ? "INTEGER" : "REAL";
		case "boolean":
			return "INTEGER";
		case "string":
			return "TEXT";
		default:
			return "TEXT";
	}
}

// ---------------------------------------------------------------------------
// resolveColumnTypes — merge observed types into a single SQLite type
// ---------------------------------------------------------------------------

/**
 * Hard cap on columns per table (T5.1/T5.3). Well under SQLite's ~2000-column
 * CREATE limit so a pathologically wide response (e.g. an object used as a map)
 * can't blow the CREATE and fail the whole stage to zero. Mirrors the legacy
 * `MAX_TABLE_COLUMNS` in schema-inference.ts.
 */
export const MAX_TABLE_COLUMNS = 200;

export function resolveColumnTypes(
	columnTypes: Record<string, Set<string>>,
): Record<string, string> {
	const columns: Record<string, string> = {};

	for (const [columnName, types] of Object.entries(columnTypes)) {
		if (types.size === 1) {
			columns[columnName] = [...types][0];
		} else {
			// Mixed types — prefer TEXT > REAL > INTEGER
			columns[columnName] = types.has("TEXT")
				? "TEXT"
				: types.has("REAL")
					? "REAL"
					: "INTEGER";
		}
	}

	return capColumns(columns);
}

/**
 * If a table would exceed MAX_TABLE_COLUMNS, keep the first (cap - 1) columns and
 * spill everything else into one `_overflow_json` TEXT column. The data-inserter
 * fills that column with the full record, so no field is silently lost — the
 * table still materializes instead of crashing the stage.
 */
function capColumns(
	columns: Record<string, string>,
): Record<string, string> {
	const names = Object.keys(columns);
	if (names.length <= MAX_TABLE_COLUMNS) return columns;
	const capped: Record<string, string> = {};
	for (const name of names.slice(0, MAX_TABLE_COLUMNS - 1)) {
		capped[name] = columns[name];
	}
	capped._overflow_json = "TEXT";
	return capped;
}

// ---------------------------------------------------------------------------
// ensureIdColumn — promote or add an `id` primary key
// ---------------------------------------------------------------------------

export function ensureIdColumn(columns: Record<string, string>): void {
	if (!columns.id) {
		columns.id = "INTEGER PRIMARY KEY AUTOINCREMENT";
	} else if (columns.id === "INTEGER") {
		columns.id = "INTEGER PRIMARY KEY";
	} else if (columns.id === "TEXT") {
		columns.id = "TEXT PRIMARY KEY";
	}
}

// ---------------------------------------------------------------------------
// hasScalarFields — check if an object has at least one non-object field
// ---------------------------------------------------------------------------

export function hasScalarFields(obj: unknown): boolean {
	if (!obj || typeof obj !== "object") return false;
	return Object.values(obj).some(
		(value) => typeof value !== "object" || value === null,
	);
}

// ---------------------------------------------------------------------------
// findOriginalKey — match a sanitized key back to the original object key
// ---------------------------------------------------------------------------

export function findOriginalKey(
	obj: Record<string, unknown>,
	sanitizedKey: string,
	config?: DomainConfig,
): string | null {
	const keys = Object.keys(obj);

	// Direct match
	if (keys.includes(sanitizedKey)) return sanitizedKey;

	// Find key whose sanitized form matches
	return (
		keys.find((key) => sanitizeColumnName(key, config) === sanitizedKey) ?? null
	);
}

// ---------------------------------------------------------------------------
// isValidId — check whether a value is a usable entity identifier
// ---------------------------------------------------------------------------

export function isValidId(id: unknown): boolean {
	return (
		id !== null &&
		id !== undefined &&
		id !== "" &&
		id !== "null" &&
		(typeof id === "number" || typeof id === "string")
	);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function randomSuffix(): string {
	return Math.random().toString(36).substring(2, 11);
}
