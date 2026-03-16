/**
 * Universal Schema Inference Engine — JSON → SQLite converter for REST API responses.
 *
 * Deterministic: same input always produces same schema.
 *
 * Improvements over v1:
 *   1. Large strings (>4KB) → TEXT (not JSON)
 *   2. Arrays of scalars → pipe-delimited TEXT columns
 *   3. Arrays of objects → child tables with parent_id FK
 *   4. Remaining JSON columns carry jsonShape metadata
 *
 * v3 improvements:
 *   5. Transaction boundaries for INSERT batches (10-50x perf gain)
 *   6. Two-pass column discovery — scans beyond sample for sparse columns
 *   7. Biological identifier auto-indexing (gene_symbol, rsid, etc.)
 *   8. Composite index support via SchemaHints
 *   9. Cached column classification (avoids redundant scans)
 *  10. Deduplicated table creation logic
 */

export interface SchemaHints {
	tableName?: string;
	columnTypes?: Record<string, string>;
	indexes?: string[];
	flatten?: Record<string, number>;
	exclude?: string[];
	/** Columns to NOT extract as child tables — keep as JSON blobs */
	skipChildTables?: string[];
	/** Max depth for recursive child table extraction (default 2: parent → child → grandchild) */
	maxRecursionDepth?: number;
	/** Multi-column indexes, e.g. [["gene_symbol", "clinical_significance"]] */
	compositeIndexes?: string[][];
}

export interface InferredColumn {
	name: string;
	type: "TEXT" | "INTEGER" | "REAL" | "JSON";
	/** Shape description for JSON columns (e.g., "{version: number, flags: object}") */
	jsonShape?: string;
	/** True for TEXT columns that contain pipe-delimited scalar arrays (searchable with LIKE) */
	pipeDelimited?: boolean;
}

/** Reference from a child table back to its parent */
export interface ChildTableRef {
	parentTable: string;
	fkColumn: string; // column name in child table, always "parent_id"
	sourceColumn: string; // column name in parent that contained the array
}

export interface InferredTable {
	name: string;
	columns: InferredColumn[];
	indexes: string[];
	/** Multi-column indexes */
	compositeIndexes?: string[][];
	/** Set on child tables extracted from arrays of objects */
	childOf?: ChildTableRef;
}

export interface InferredSchema {
	tables: InferredTable[];
}

const KNOWN_ARRAY_KEYS = ["data", "results", "items", "records", "hits", "entries", "rows"];
const ID_PATTERN = /^(id|.*_id|.*Id)$/;
const MAX_SCAN_ROWS = 100;
/** Scan up to this many rows for column name discovery (beyond MAX_SCAN_ROWS) */
const MAX_DISCOVERY_ROWS = 1000;
/** SQLite max columns safety limit — child tables exceeding this stay as JSON */
const MAX_CHILD_TABLE_COLUMNS = 100;
/** Default max recursion depth for child table extraction (parent=0 → child=1 → grandchild=2) */
const DEFAULT_MAX_RECURSION_DEPTH = 2;

/**
 * Common biological identifier patterns that benefit from automatic indexing.
 * These are queried frequently across gnomAD, ClinVar, PharmGKB, FAERS, etc.
 */
const BIO_INDEX_PATTERNS = [
	/^(gene_symbol|gene_name|gene_id|gene_label|entrez_id|ensembl_id)$/,
	/^(rsid|variant_id|hgvs_c|hgvs_p|hgvs_g)$/,
	/^(clinical_significance|classification_label|outcome_label|review_status|pathogenicity)$/,
	/^(chromosome|chrom|chr)$/,
	/^(drug_name|compound_name|medication_name|medicinalproduct)$/,
	/^(disease_name|condition|condition_label|phenotype)$/,
	/^(transcript_id|protein_id|uniprot_id)$/,
];

/** Check if a column name should be auto-indexed (ID patterns + biological identifiers). */
function shouldAutoIndex(colName: string): boolean {
	if (ID_PATTERN.test(colName)) return true;
	return BIO_INDEX_PATTERNS.some((p) => p.test(colName));
}

/**
 * Find the array(s) in a JSON response that should become tables.
 */
export function detectArrays(
	data: unknown,
): Array<{ key: string; rows: unknown[] }> {
	if (Array.isArray(data)) {
		return [{ key: "data", rows: data }];
	}

	if (typeof data !== "object" || data === null) return [];

	const obj = data as Record<string, unknown>;
	const found: Array<{ key: string; rows: unknown[] }> = [];

	// Check known wrapper keys first
	for (const key of KNOWN_ARRAY_KEYS) {
		if (Array.isArray(obj[key])) {
			found.push({ key, rows: obj[key] as unknown[] });
		}
	}

	if (found.length > 0) return found;

	// HAL+JSON: { _embedded: { studies: [...], associations: [...] } }
	// Common in EBI/Spring HATEOAS APIs. Traverse into _embedded to find arrays.
	const embedded = obj._embedded;
	if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
		const embeddedObj = embedded as Record<string, unknown>;
		for (const [key, value] of Object.entries(embeddedObj)) {
			if (Array.isArray(value) && value.length > 0) {
				found.push({ key, rows: value });
			}
		}
		if (found.length > 0) return found;
	}

	// Handle single-key wrapper objects (common in GraphQL responses)
	// e.g., { entry: { struct: {...}, exptl: [...] } } → unwrap and recurse
	// Also handles nested wrappers like { genes: { nodes: [...] } }
	const keys = Object.keys(obj);
	if (keys.length === 1) {
		const inner = obj[keys[0]];
		if (Array.isArray(inner) && inner.length > 0) {
			return [{ key: keys[0], rows: inner }];
		}
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			// Recurse to unwrap nested wrappers (e.g., { genes: { nodes: [...] } })
			const innerResult = detectArrays(inner);
			if (innerResult.length > 0) return innerResult;
			// Single object response — wrap in array for single-row table
			return [{ key: keys[0], rows: [inner] }];
		}
	}

	// Fall back to any top-level array property
	for (const [key, value] of Object.entries(obj)) {
		if (Array.isArray(value) && value.length > 0) {
			found.push({ key, rows: value });
		}
	}

	return found;
}

/**
 * Flatten an object's keys with `_` separator up to a given depth.
 */
export function flattenObject(
	obj: Record<string, unknown>,
	maxDepth: number,
	depthOverrides?: Record<string, number>,
	prefix = "",
	currentDepth = 0,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}_${key}` : key;
		const effectiveMaxDepth = depthOverrides?.[key] ?? maxDepth;

		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			currentDepth < effectiveMaxDepth
		) {
			Object.assign(
				result,
				flattenObject(
					value as Record<string, unknown>,
					maxDepth,
					depthOverrides,
					fullKey,
					currentDepth + 1,
				),
			);
		} else {
			result[fullKey] = value;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Column type classification
// ---------------------------------------------------------------------------

/** Check if all non-null items in an array are scalars (not objects/arrays). */
function isScalarArray(arr: unknown[]): boolean {
	for (const item of arr) {
		if (item === null || item === undefined) continue;
		if (typeof item === "object") return false;
	}
	return true;
}

/** Check if all non-null items in an array are objects (not arrays/scalars). */
function isObjectArray(arr: unknown[]): boolean {
	let hasObject = false;
	for (const item of arr) {
		if (item === null || item === undefined) continue;
		if (typeof item !== "object" || Array.isArray(item)) return false;
		hasObject = true;
	}
	return hasObject;
}

/**
 * Classify a column's values into one of:
 *   - "scalar_array" — array of primitives → will become pipe-delimited TEXT
 *   - "object_array" — array of objects → will become a child table
 *   - "plain" — not an array column, use normal type inference
 */
type ArrayClassification = "scalar_array" | "object_array" | "plain";

function classifyColumn(values: unknown[]): ArrayClassification {
	const nonNull = values.filter((v) => v !== null && v !== undefined);
	if (nonNull.length === 0) return "plain";

	const arrayValues = nonNull.filter((v) => Array.isArray(v));
	// At least 75% of non-null values must be arrays to classify as array column
	if (arrayValues.length < nonNull.length * 0.75) return "plain";

	// Sample from the first non-empty array
	const sampleArr = arrayValues.find(
		(a) => (a as unknown[]).length > 0,
	) as unknown[] | undefined;
	if (!sampleArr || sampleArr.length === 0) return "scalar_array"; // all empty arrays

	if (isObjectArray(sampleArr)) return "object_array";
	if (isScalarArray(sampleArr)) return "scalar_array";
	return "plain"; // mixed or nested arrays — keep as JSON
}

/**
 * Infer the SQLite column type from sampled values.
 * Fix: large strings are TEXT, not JSON. Only actual objects get JSON type.
 */
function inferColumnType(values: unknown[]): "TEXT" | "INTEGER" | "REAL" | "JSON" {
	let hasInteger = false;
	let hasReal = false;
	let hasObject = false;

	for (const v of values) {
		if (v === null || v === undefined) continue;
		if (typeof v === "number") {
			if (Number.isInteger(v)) hasInteger = true;
			else hasReal = true;
		} else if (typeof v === "boolean") {
			hasInteger = true;
		} else if (typeof v === "object") {
			hasObject = true;
		}
		// Large strings are just TEXT — no special JSON classification
	}

	if (hasObject) return "JSON";
	if (hasReal) return "REAL";
	if (hasInteger && !hasReal) return "INTEGER";
	return "TEXT";
}

/**
 * Build a jsonShape descriptor from sampled object values.
 * Returns a compact representation like "{version: number, flags: object}".
 */
function buildJsonShape(values: unknown[]): string | undefined {
	const objectValues = values.filter(
		(v) => v !== null && typeof v === "object" && !Array.isArray(v),
	) as Record<string, unknown>[];
	if (objectValues.length === 0) return undefined;

	// Union keys from all sampled objects
	const keyTypes = new Map<string, Set<string>>();
	for (const obj of objectValues.slice(0, 10)) {
		for (const [k, v] of Object.entries(obj)) {
			if (!keyTypes.has(k)) keyTypes.set(k, new Set());
			if (v === null || v === undefined) keyTypes.get(k)!.add("null");
			else if (Array.isArray(v)) keyTypes.get(k)!.add("array");
			else keyTypes.get(k)!.add(typeof v);
		}
	}

	const parts: string[] = [];
	for (const [k, types] of keyTypes) {
		const typeStr = [...types].join("|");
		parts.push(`${k}: ${typeStr}`);
	}
	return `{${parts.join(", ")}}`;
}

/**
 * Infer a child table schema from sampled array-of-object values.
 *
 * Recursively extracts grandchild tables when child columns contain object arrays,
 * up to `maxRecursionDepth` levels deep.
 *
 * @param depth Current recursion depth (0 = top-level child, 1 = grandchild, etc.)
 * @param maxRecursionDepth Max depth for recursive extraction (default DEFAULT_MAX_RECURSION_DEPTH)
 * @returns Array of InferredTable — the child table plus any grandchild tables
 */
function inferChildTableSchema(
	parentTableName: string,
	sourceColumn: string,
	values: unknown[],
	depth = 0,
	maxRecursionDepth = DEFAULT_MAX_RECURSION_DEPTH,
): InferredTable[] {
	const childTableName = `${parentTableName}_${sourceColumn}`;

	// Collect all items from all arrays for this column
	const allItems: Record<string, unknown>[] = [];
	for (const v of values) {
		if (!Array.isArray(v)) continue;
		for (const item of v) {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				allItems.push(item as Record<string, unknown>);
			}
		}
	}

	if (allItems.length === 0) {
		return [{
			name: childTableName,
			columns: [{ name: "parent_id", type: "INTEGER" }],
			indexes: ["parent_id"],
			childOf: { parentTable: parentTableName, fkColumn: "parent_id", sourceColumn },
		}];
	}

	// Flatten child items to depth 1 (no deep nesting in child tables)
	const sampleItems = allItems.slice(0, MAX_SCAN_ROWS);
	const flatItems = sampleItems.map((item) => flattenObject(item, 1));

	// Collect column values
	const columnValues = new Map<string, unknown[]>();
	for (const flat of flatItems) {
		for (const [col, val] of Object.entries(flat)) {
			if (!columnValues.has(col)) columnValues.set(col, []);
			columnValues.get(col)!.push(val);
		}
	}

	// Build child columns — parent_id first
	const columns: InferredColumn[] = [{ name: "parent_id", type: "INTEGER" }];
	const indexes: string[] = ["parent_id"];
	const grandchildTables: InferredTable[] = [];

	for (const [rawColName, colValues] of columnValues) {
		// Rename source columns that collide with the synthetic parent_id FK
		const colName = rawColName === "parent_id" ? "source_parent_id" : rawColName;

		const classification = classifyColumn(colValues);

		// Recurse into object arrays if we haven't hit the depth limit
		if (classification === "object_array" && depth + 1 < maxRecursionDepth) {
			const grandchildResults = inferChildTableSchema(
				childTableName,
				colName,
				colValues,
				depth + 1,
				maxRecursionDepth,
			);
			// Check column count safety valve on the immediate grandchild table
			const immediateGrandchild = grandchildResults[0];
			if (immediateGrandchild.columns.length <= MAX_CHILD_TABLE_COLUMNS) {
				grandchildTables.push(...grandchildResults);
				continue; // Don't add this column to the child table
			}
			// Falls through to add as JSON column if too many columns
		}

		let type: InferredColumn["type"];
		let jsonShape: string | undefined;
		let isPipeDelimited = false;

		if (classification === "scalar_array") {
			type = "TEXT";
			isPipeDelimited = true;
		} else {
			type = inferColumnType(colValues);
			if (type === "JSON") {
				jsonShape = buildJsonShape(colValues);
			}
		}

		columns.push({
			name: colName,
			type,
			...(jsonShape ? { jsonShape } : {}),
			...(isPipeDelimited ? { pipeDelimited: true } : {}),
		});

		if (shouldAutoIndex(colName) && !indexes.includes(colName)) {
			indexes.push(colName);
		}
	}

	const childTable: InferredTable = {
		name: childTableName,
		columns,
		indexes,
		childOf: { parentTable: parentTableName, fkColumn: "parent_id", sourceColumn },
	};

	return [childTable, ...grandchildTables];
}

// ---------------------------------------------------------------------------
// Schema inference
// ---------------------------------------------------------------------------

/**
 * Infer a complete schema from detected arrays.
 *
 * Two-pass column discovery:
 *   Pass 1: Flatten up to MAX_SCAN_ROWS for type inference.
 *   Pass 2: Scan up to MAX_DISCOVERY_ROWS beyond the sample to find
 *           sparse columns that only appear in later rows.
 *
 * Column classification is cached from the first pass to avoid redundant scans.
 */
export function inferSchema(
	arrays: Array<{ key: string; rows: unknown[] }>,
	hints?: SchemaHints,
): InferredSchema {
	const tables: InferredTable[] = [];
	const exclude = new Set(hints?.exclude ?? []);
	const skipChildTables = new Set(hints?.skipChildTables ?? []);

	for (const { key, rows } of arrays) {
		if (rows.length === 0) continue;

		const tableName = hints?.tableName ?? sanitizeTableName(key);

		// --- Pass 1: Flatten sample rows for type inference ---
		const sampleRows = rows.slice(0, MAX_SCAN_ROWS);
		const flattenedSample = sampleRows.map((row) => {
			if (typeof row !== "object" || row === null) return { value: row };
			return flattenObject(row as Record<string, unknown>, 2, hints?.flatten);
		});

		const columnValues = new Map<string, unknown[]>();
		for (const row of flattenedSample) {
			for (const [col, val] of Object.entries(row)) {
				if (exclude.has(col)) continue;
				if (!columnValues.has(col)) columnValues.set(col, []);
				columnValues.get(col)!.push(val);
			}
		}

		// --- Pass 2: Discover sparse columns beyond the sample ---
		// Only enumerates keys from additional rows; values are collected
		// only for newly discovered columns to preserve classification thresholds.
		if (rows.length > MAX_SCAN_ROWS) {
			const discoveryEnd = Math.min(rows.length, MAX_DISCOVERY_ROWS);
			const newColumns = new Set<string>();
			for (let i = MAX_SCAN_ROWS; i < discoveryEnd; i++) {
				const row = rows[i];
				if (typeof row !== "object" || row === null) continue;
				const flat = flattenObject(row as Record<string, unknown>, 2, hints?.flatten);
				for (const [col, val] of Object.entries(flat)) {
					if (exclude.has(col)) continue;
					if (!columnValues.has(col)) {
						columnValues.set(col, []);
						newColumns.add(col);
					}
					// Collect values only for newly discovered columns
					if (newColumns.has(col)) {
						columnValues.get(col)!.push(val);
					}
				}
			}
		}

		// --- Classify columns (cached for reuse in second pass) ---
		const classificationCache = new Map<string, ArrayClassification>();

		// First pass: classify and extract child tables
		const childTables: InferredTable[] = [];
		const childSourceColumns = new Set<string>();
		const maxRecursionDepth = hints?.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH;

		for (const [colName, values] of columnValues) {
			if (skipChildTables.has(colName)) continue;

			const classification = classifyColumn(values);
			classificationCache.set(colName, classification);

			if (classification === "object_array") {
				const childTableResults = inferChildTableSchema(tableName, colName, values, 0, maxRecursionDepth);
				const immediateChild = childTableResults[0];
				if (immediateChild.columns.length <= MAX_CHILD_TABLE_COLUMNS) {
					childTables.push(...childTableResults);
					childSourceColumns.add(colName);
				}
			}
		}

		// Second pass: build parent columns (using cached classifications)
		const columns: InferredColumn[] = [];
		const indexes: string[] = [...(hints?.indexes ?? [])];

		for (const [colName, values] of columnValues) {
			// Skip columns that became child tables
			if (childSourceColumns.has(colName)) continue;

			const overrideType = hints?.columnTypes?.[colName];
			let type: InferredColumn["type"];
			let jsonShape: string | undefined;

			let isPipeDelimited = false;

			if (overrideType) {
				type = overrideType as InferredColumn["type"];
			} else {
				// Use cached classification from first pass, or compute if not cached
				const classification = classificationCache.get(colName) ?? classifyColumn(values);
				if (classification === "scalar_array") {
					type = "TEXT";
					isPipeDelimited = true;
				} else {
					type = inferColumnType(values);
				}
			}

			// Add jsonShape for JSON columns
			if (type === "JSON") {
				jsonShape = buildJsonShape(values);
			}

			columns.push({
				name: colName,
				type,
				...(jsonShape ? { jsonShape } : {}),
				...(isPipeDelimited ? { pipeDelimited: true } : {}),
			});

			// Auto-index: ID patterns + biological identifiers
			if (shouldAutoIndex(colName) && !indexes.includes(colName)) {
				indexes.push(colName);
			}
		}

		// Composite indexes from hints (only if all columns exist in the table)
		const compositeIndexes: string[][] = [];
		if (hints?.compositeIndexes) {
			const colNameSet = new Set(columns.map((c) => c.name));
			for (const composite of hints.compositeIndexes) {
				if (composite.every((col) => colNameSet.has(col))) {
					compositeIndexes.push(composite);
				}
			}
		}

		tables.push({
			name: tableName,
			columns,
			indexes,
			...(compositeIndexes.length > 0 ? { compositeIndexes } : {}),
		});
		// Append child tables after parent
		tables.push(...childTables);
	}

	return { tables };
}

function sanitizeTableName(key: string): string {
	return key
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

export interface MaterializationWarning {
	rowIndex: number;
	table: string;
	error: string;
}

export interface MaterializationResult {
	tablesCreated: string[];
	totalRows: number;
	inputRows: number;
	failedRows: number;
	warnings: MaterializationWarning[];
	/** Row count per table — useful for reporting per-table breakdowns */
	tableRowCounts: Record<string, number>;
}

/**
 * Convert a value for SQL insertion.
 * - Arrays of scalars → pipe-delimited string
 * - Objects/remaining arrays → JSON.stringify
 * - null/undefined → null
 * - Scalars → as-is
 */
function sqlValue(v: unknown): unknown {
	if (v === null || v === undefined) return null;
	if (Array.isArray(v)) {
		if (v.length === 0) return null;
		// Arrays containing objects → JSON.stringify to preserve structure
		// (prevents data loss from String({}) → "[object Object]")
		if (v.some((item) => item !== null && typeof item === "object")) {
			return JSON.stringify(v);
		}
		// Scalar array → pipe-delimited
		return v.map((item) => String(item)).join(" | ");
	}
	if (typeof v === "object") return JSON.stringify(v);
	return v;
}

// ---------------------------------------------------------------------------
// Table creation helper (shared by parent and child table materialization)
// ---------------------------------------------------------------------------

function createTableAndIndexes(
	table: InferredTable,
	sql: { exec: (query: string, ...bindings: unknown[]) => unknown },
): void {
	const hasIdColumn = table.columns.some((c) => c.name === "id");
	const colDefs = table.columns
		.map((c) => `"${c.name}" ${c.type}`)
		.join(", ");
	const createSql = hasIdColumn
		? `CREATE TABLE IF NOT EXISTS "${table.name}" (_rowid INTEGER PRIMARY KEY AUTOINCREMENT${colDefs ? `, ${colDefs}` : ""})`
		: `CREATE TABLE IF NOT EXISTS "${table.name}" (id INTEGER PRIMARY KEY AUTOINCREMENT${colDefs ? `, ${colDefs}` : ""})`;
	sql.exec(createSql);

	for (const idx of table.indexes) {
		sql.exec(
			`CREATE INDEX IF NOT EXISTS "idx_${table.name}_${idx}" ON "${table.name}"("${idx}")`,
		);
	}

	// Composite indexes
	if (table.compositeIndexes) {
		for (const composite of table.compositeIndexes) {
			const idxName = `idx_${table.name}_${composite.join("_")}`;
			const colList = composite.map((c) => `"${c}"`).join(", ");
			sql.exec(
				`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${table.name}"(${colList})`,
			);
		}
	}
}

/**
 * Generate CREATE TABLE + INSERT statements and execute them.
 *
 * Handles parent/child/grandchild table relationships:
 * - Tables are processed in topological order (parent before child before grandchild)
 * - Each level tracks row IDs for FK resolution at the next level
 *
 * Callers should wrap this in a transaction for performance
 * (10-50x faster than implicit per-statement autocommit).
 * In Cloudflare Durable Objects, use ctx.storage.transactionSync().
 */
export function materializeSchema(
	schema: InferredSchema,
	rows: Map<string, unknown[]>,
	sql: {
		exec: (query: string, ...bindings: unknown[]) => unknown;
	},
	hints?: SchemaHints,
): MaterializationResult {
	const tablesCreated: string[] = [];
	let totalRows = 0;
	let inputRows = 0;
	let failedRows = 0;
	const warnings: MaterializationWarning[] = [];
	const tableRowCounts: Record<string, number> = {};
	const MAX_SAMPLE_ERRORS = 10;

	// Build child tables index: parentName → immediate children
	const childTablesByParent = new Map<string, InferredTable[]>();
	for (const ct of schema.tables.filter((t) => t.childOf)) {
		const parentName = ct.childOf!.parentTable;
		if (!childTablesByParent.has(parentName)) childTablesByParent.set(parentName, []);
		childTablesByParent.get(parentName)!.push(ct);
	}

	/**
	 * Create a table, insert rows, track IDs, then recurse into child tables.
	 *
	 * ID tracking correctness: we use a manual counter (nextId) that increments
	 * only on successful INSERT. This stays in sync with SQLite AUTOINCREMENT because:
	 * - Each DO instance is created fresh (no pre-existing rows)
	 * - Failed INSERTs don't advance SQLite's auto-increment counter
	 * - We never delete rows during materialization
	 */
	function materializeTable(
		table: InferredTable,
		tableRows: unknown[],
		flattenDepth: number,
	): void {
		createTableAndIndexes(table, sql);

		// Child tables of this table
		const myChildTables = childTablesByParent.get(table.name) ?? [];

		const colNames = table.columns.map((c) => c.name);
		const placeholders = colNames.map(() => "?").join(", ");
		const insertSql = `INSERT INTO "${table.name}" (${colNames.map((n) => `"${n}"`).join(", ")}) VALUES (${placeholders})`;

		// Track IDs for FK resolution and capture child array data
		const idMap = new Map<number, number>();
		const capturedChildData = new Map<string, Array<{ parentIndex: number; items: unknown[] }>>();
		for (const ct of myChildTables) {
			capturedChildData.set(ct.name, []);
		}
		let nextId = 1;

		for (let i = 0; i < tableRows.length; i++) {
			const row = tableRows[i];
			const flat =
				typeof row === "object" && row !== null
					? flattenObject(row as Record<string, unknown>, flattenDepth, hints?.flatten)
					: { value: row };

			// Capture child array data before inserting
			for (const ct of myChildTables) {
				const sourceCol = ct.childOf!.sourceColumn;
				const arr = (flat as Record<string, unknown>)[sourceCol];
				if (Array.isArray(arr) && arr.length > 0) {
					capturedChildData.get(ct.name)!.push({ parentIndex: i, items: arr });
				}
			}

			const values = colNames.map((col) => {
				const v = (flat as Record<string, unknown>)[col];
				return sqlValue(v);
			});

			try {
				sql.exec(insertSql, ...values);
				idMap.set(i, nextId++);
				totalRows++;
				tableRowCounts[table.name] = (tableRowCounts[table.name] ?? 0) + 1;
			} catch (err) {
				failedRows++;
				if (warnings.length < MAX_SAMPLE_ERRORS) {
					warnings.push({
						rowIndex: i,
						table: table.name,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		tablesCreated.push(table.name);

		// Recurse into child tables
		for (const childTable of myChildTables) {
			materializeChildTable(childTable, capturedChildData.get(childTable.name) ?? [], idMap);
		}
	}

	/**
	 * Create and populate a child table, then recurse into its own children (grandchild tables).
	 */
	function materializeChildTable(
		childTable: InferredTable,
		captured: Array<{ parentIndex: number; items: unknown[] }>,
		parentIdMap: Map<number, number>,
	): void {
		createTableAndIndexes(childTable, sql);

		// Grandchild tables of this child table
		const myGrandchildTables = childTablesByParent.get(childTable.name) ?? [];

		const childColNames = childTable.columns.map((c) => c.name);
		const childPlaceholders = childColNames.map(() => "?").join(", ");
		const childInsertSql = `INSERT INTO "${childTable.name}" (${childColNames.map((n) => `"${n}"`).join(", ")}) VALUES (${childPlaceholders})`;

		// Track child IDs for grandchild FK resolution
		const childIdMap = new Map<number, number>();
		const capturedGrandchildData = new Map<string, Array<{ parentIndex: number; items: unknown[] }>>();
		for (const gct of myGrandchildTables) {
			capturedGrandchildData.set(gct.name, []);
		}
		let nextChildId = 1;
		let childRowIndex = 0;

		for (const { parentIndex, items } of captured) {
			const parentId = parentIdMap.get(parentIndex);
			if (parentId === undefined) continue; // parent failed to insert

			for (let j = 0; j < items.length; j++) {
				const item = items[j];
				const childFlat =
					item !== null && typeof item === "object" && !Array.isArray(item)
						? flattenObject(item as Record<string, unknown>, 1)
						: { value: item };

				// Capture grandchild array data before inserting child
				for (const gct of myGrandchildTables) {
					const sourceCol = gct.childOf!.sourceColumn;
					const arr = (childFlat as Record<string, unknown>)[sourceCol];
					if (Array.isArray(arr) && arr.length > 0) {
						capturedGrandchildData.get(gct.name)!.push({ parentIndex: childRowIndex, items: arr });
					}
				}

				const childValues = childColNames.map((col) => {
					if (col === "parent_id") return parentId;
					// Reverse the source_parent_id rename from schema inference
					const lookupKey = col === "source_parent_id" ? "parent_id" : col;
					const v = (childFlat as Record<string, unknown>)[lookupKey];
					return sqlValue(v);
				});

				try {
					sql.exec(childInsertSql, ...childValues);
					childIdMap.set(childRowIndex, nextChildId++);
					totalRows++;
					tableRowCounts[childTable.name] = (tableRowCounts[childTable.name] ?? 0) + 1;
				} catch (err) {
					failedRows++;
					if (warnings.length < MAX_SAMPLE_ERRORS) {
						warnings.push({
							rowIndex: j,
							table: childTable.name,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				childRowIndex++;
			}
		}

		tablesCreated.push(childTable.name);

		// Recurse into grandchild tables
		for (const grandchildTable of myGrandchildTables) {
			materializeChildTable(
				grandchildTable,
				capturedGrandchildData.get(grandchildTable.name) ?? [],
				childIdMap,
			);
		}
	}

	// Process root (parent) tables
	const parentTables = schema.tables.filter((t) => !t.childOf);
	for (const table of parentTables) {
		const tableRows = rows.get(table.name) ?? [];
		inputRows += tableRows.length;
		materializeTable(table, tableRows, 2);
	}

	return { tablesCreated, totalRows, inputRows, failedRows, warnings, tableRowCounts };
}
