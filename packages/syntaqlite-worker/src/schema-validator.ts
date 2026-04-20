/**
 * SchemaValidator — pure-TypeScript SQL validation against a known schema.
 *
 * Checks column and table names referenced in SQL queries against the schema
 * and provides "did you mean?" suggestions using Levenshtein distance.
 * No WASM dependency — runs synchronously in any JS environment.
 */

import type { InferredSchema } from "./schema-to-ddl";

export interface SchemaValidationResult {
	valid: boolean;
	diagnostics: SchemaValidationDiagnostic[];
}

export interface SchemaValidationDiagnostic {
	severity: "error" | "warning";
	message: string;
	help?: string;
	kind: "unknown_column" | "unknown_table";
}

/**
 * Compute Levenshtein edit distance between two strings.
 * Used for "did you mean?" suggestions.
 */
function editDistance(a: string, b: string): number {
	const la = a.length;
	const lb = b.length;
	const dp: number[][] = Array.from({ length: la + 1 }, () =>
		Array.from({ length: lb + 1 }, () => 0),
	);
	for (let i = 0; i <= la; i++) dp[i][0] = i;
	for (let j = 0; j <= lb; j++) dp[0][j] = j;
	for (let i = 1; i <= la; i++) {
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + cost,
			);
		}
	}
	return dp[la][lb];
}

/**
 * Find the closest match from a set of candidates using edit distance.
 * Returns the suggestion only if the distance is within threshold.
 */
function findClosestMatch(
	input: string,
	candidates: ReadonlySet<string>,
	maxDistance = 3,
): string | undefined {
	const lower = input.toLowerCase();
	let best: string | undefined;
	let bestDist = maxDistance + 1;

	for (const candidate of candidates) {
		// Quick length check — if lengths differ by more than maxDistance, skip
		if (Math.abs(candidate.length - lower.length) > maxDistance) continue;

		const dist = editDistance(lower, candidate.toLowerCase());
		if (dist < bestDist) {
			bestDist = dist;
			best = candidate;
		}
	}

	return bestDist <= maxDistance ? best : undefined;
}

/**
 * Extract identifiers from a SQL query that appear after FROM, JOIN, or INTO
 * (likely table names) and in the SELECT/WHERE/ORDER BY/GROUP BY clauses
 * (likely column names). Uses simple regex-based extraction.
 *
 * This is intentionally simple — it catches common typos without
 * needing a full SQL parser. The WASM-based SqlValidator can be
 * layered on top for full syntax validation later.
 */
function extractReferencedIdentifiers(sql: string): {
	tableRefs: string[];
	columnRefs: string[];
} {
	const tableRefs: string[] = [];
	const columnRefs: string[] = [];

	// Remove string literals and comments to avoid false matches
	const cleaned = sql
		.replace(/'[^']*'/g, "''") // string literals
		.replace(/--.*$/gm, "") // line comments
		.replace(/\/\*[\s\S]*?\*\//g, ""); // block comments

	// Extract table references: after FROM, JOIN, INTO, UPDATE
	const tablePattern =
		/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"([^"]+)"|(\w+))/gi;
	let match: RegExpExecArray | null;
	while ((match = tablePattern.exec(cleaned)) !== null) {
		const name = match[1] ?? match[2];
		if (name) tableRefs.push(name);
	}

	// Extract column references in SELECT, WHERE, ORDER BY, GROUP BY, HAVING, ON
	// Match: identifier or "quoted identifier" not preceded by FROM/JOIN/INTO
	// We look for bare identifiers that aren't SQL keywords
	const sqlKeywords = new Set([
		"select", "from", "where", "join", "inner", "outer", "left", "right",
		"cross", "on", "and", "or", "not", "in", "is", "null", "like",
		"between", "exists", "case", "when", "then", "else", "end",
		"as", "asc", "desc", "limit", "offset", "order", "by", "group",
		"having", "distinct", "union", "all", "insert", "into", "update",
		"set", "delete", "values", "true", "false", "count", "sum", "avg",
		"min", "max", "coalesce", "ifnull", "cast", "typeof", "length",
		"lower", "upper", "trim", "replace", "substr", "instr", "abs",
		"round", "date", "time", "datetime", "julianday", "strftime",
		"json_extract", "json_each", "json_array", "json_object",
		"json_group_array", "json_group_object", "printf", "glob",
		"hex", "zeroblob", "randomblob", "unicode", "char",
		"total_changes", "changes", "last_insert_rowid",
	]);

	// Collect aliases (identifiers after AS) — these should not be validated
	const aliases = new Set<string>();
	const aliasPattern = /\bAS\s+(?:"([^"]+)"|(\w+))/gi;
	while ((match = aliasPattern.exec(cleaned)) !== null) {
		const name = match[1] ?? match[2];
		if (name) aliases.add(name.toLowerCase());
	}

	// Match table.column or bare column references
	const colPattern = /(?:(\w+)\.)?(?:"([^"]+)"|(\w+))/g;
	while ((match = colPattern.exec(cleaned)) !== null) {
		const qualifier = match[1];
		const name = match[2] ?? match[3];
		if (!name) continue;

		// Skip SQL keywords, numbers, known table refs, and aliases
		if (sqlKeywords.has(name.toLowerCase())) continue;
		if (/^\d+$/.test(name)) continue;
		if (tableRefs.includes(name)) continue;
		if (aliases.has(name.toLowerCase())) continue;

		// If qualified (table.column), treat as column ref
		if (qualifier) {
			columnRefs.push(name);
		} else {
			// Unqualified identifiers could be columns or aliases
			columnRefs.push(name);
		}
	}

	return { tableRefs, columnRefs };
}

/**
 * Schema-aware SQL validator using pure TypeScript.
 *
 * Validates column and table name references in SQL queries against a
 * known schema, providing "did you mean?" suggestions for typos.
 */
export class SchemaValidator {
	private readonly tableNames: ReadonlySet<string>;
	private readonly allColumnNames: ReadonlySet<string>;
	private readonly columnsByTable: ReadonlyMap<string, ReadonlySet<string>>;

	constructor(schema: InferredSchema) {
		const tableNames = new Set<string>();
		const allColumns = new Set<string>();
		const columnsByTable = new Map<string, Set<string>>();

		for (const table of schema.tables) {
			tableNames.add(table.name);
			const cols = new Set<string>();
			// Always include the auto-generated id/_rowid column
			const hasIdCol = table.columns.some((c) => c.name === "id");
			cols.add(hasIdCol ? "_rowid" : "id");
			for (const col of table.columns) {
				cols.add(col.name);
				allColumns.add(col.name);
			}
			columnsByTable.set(table.name, cols);
		}

		// Add common auto-generated columns to global set
		allColumns.add("id");
		allColumns.add("_rowid");

		this.tableNames = tableNames;
		this.allColumnNames = allColumns;
		this.columnsByTable = columnsByTable;
	}

	/**
	 * Validate a SQL query against the schema.
	 * Returns diagnostics for unknown table/column references with suggestions.
	 */
	validate(sql: string): SchemaValidationResult {
		const { tableRefs, columnRefs } = extractReferencedIdentifiers(sql);
		const diagnostics: SchemaValidationDiagnostic[] = [];

		// Check table references
		for (const ref of tableRefs) {
			if (this.tableNames.has(ref)) continue;
			const suggestion = findClosestMatch(ref, this.tableNames);
			diagnostics.push({
				severity: "error",
				message: `unknown table '${ref}'`,
				help: suggestion ? `did you mean '${suggestion}'?` : undefined,
				kind: "unknown_table",
			});
		}

		// Check column references against all known columns
		for (const ref of columnRefs) {
			if (this.allColumnNames.has(ref)) continue;
			const suggestion = findClosestMatch(ref, this.allColumnNames);
			if (suggestion) {
				diagnostics.push({
					severity: "error",
					message: `unknown column '${ref}'`,
					help: `did you mean '${suggestion}'?`,
					kind: "unknown_column",
				});
			}
			// If no suggestion found, don't flag — the column might be an alias,
			// expression result, or from a subquery we can't see
		}

		return {
			valid: diagnostics.length === 0,
			diagnostics,
		};
	}

	/** Build a human-readable error message from diagnostics. */
	static formatErrorMessage(result: SchemaValidationResult): string {
		if (result.diagnostics.length === 0) return "";
		return result.diagnostics
			.map((d) => (d.help ? `${d.message} (${d.help})` : d.message))
			.join("; ");
	}
}
