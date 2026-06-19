/**
 * Data Inserter — 2-phase insertion of entities into SQLite tables.
 *
 * Phase 1: Insert all entities depth-first (children before parents)
 *          so FK references are available when the parent is inserted.
 * Phase 2: Insert junction table records for many-to-many relationships.
 *
 * Design principle: NEVER silently lose data.
 *   - Insert failures are collected and reported in the result.
 *   - Fields that don't match any column are not dropped — the schema-builder
 *     should already have created columns for them (as _json or flattened).
 */

import type { DomainConfig, SqlExec, TableSchema } from "./types";
import { isEntity, inferEntityType } from "./entity-discovery";
import {
	findOriginalKey,
	isValidId,
} from "./normalizer";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InsertionResult {
	totalRows: number;
	errors: string[];
}

/**
 * Insert data into pre-created tables according to the given schemas.
 */
export function insertData(
	data: unknown,
	schemas: Record<string, TableSchema>,
	sql: SqlExec,
	config?: DomainConfig,
): InsertionResult {
	const state: InsertionState = {
		processedEntities: new Map(),
		relationshipData: new Map(),
		totalRows: 0,
		errors: [],
	};

	const schemaNames = Object.keys(schemas);

	// Handle simple fallback schemas
	if (
		schemaNames.length === 1 &&
		(schemaNames[0] === "scalar_data" ||
			schemaNames[0] === "array_data" ||
			schemaNames[0] === "root_object")
	) {
		const tableName = schemaNames[0];
		const schema = schemas[tableName];
		if (tableName === "scalar_data" || tableName === "root_object") {
			insertSimpleRow(data, tableName, schema, sql, state, config);
		} else if (Array.isArray(data)) {
			for (const item of data) {
				insertSimpleRow(item, tableName, schema, sql, state, config);
			}
		} else {
			insertSimpleRow(data, tableName, schema, sql, state, config);
		}
		return { totalRows: state.totalRows, errors: state.errors };
	}

	// Phase 1: Insert entities (children first via depth-first traversal)
	insertAllEntities(data, schemas, sql, state, [], config);

	// Phase 2: Insert junction table records
	insertJunctionRecords(schemas, sql, state);

	return { totalRows: state.totalRows, errors: state.errors };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface InsertionState {
	/** entityType → Map<objectRef, insertedId> */
	processedEntities: Map<string, Map<unknown, number | string>>;
	/** junctionTableName → Set<"id1::id2"> */
	relationshipData: Map<string, Set<string>>;
	totalRows: number;
	errors: string[];
}

// ---------------------------------------------------------------------------
// Phase 1: Depth-first entity insertion
// ---------------------------------------------------------------------------

function insertAllEntities(
	obj: unknown,
	schemas: Record<string, TableSchema>,
	sql: SqlExec,
	state: InsertionState,
	path: string[],
	config?: DomainConfig,
): void {
	if (!obj || typeof obj !== "object") return;

	// Handle arrays
	if (Array.isArray(obj)) {
		for (const item of obj) {
			insertAllEntities(item, schemas, sql, state, path, config);
		}
		return;
	}

	const record = obj as Record<string, unknown>;

	// Unwrap GraphQL edges pattern
	if (record.edges && Array.isArray(record.edges)) {
		const nodes = (record.edges as Array<Record<string, unknown>>)
			.map((edge) => edge.node)
			.filter(Boolean);
		for (const node of nodes) {
			insertAllEntities(node, schemas, sql, state, path, config);
		}
		return;
	}

	// Unwrap {nodes: [...]} wrapper
	if (record.nodes && Array.isArray(record.nodes) && !isEntity(obj, config)) {
		for (const node of record.nodes as unknown[]) {
			insertAllEntities(node, schemas, sql, state, path, config);
		}
		return;
	}

	// Unwrap {rows: [...]} wrapper
	if (record.rows && Array.isArray(record.rows) && !isEntity(obj, config)) {
		for (const row of record.rows as unknown[]) {
			insertAllEntities(row, schemas, sql, state, path, config);
		}
		return;
	}

	// CHILDREN FIRST: recurse into all nested values before inserting this entity.
	// This ensures child entities are in processedEntities before the parent
	// tries to resolve foreign keys.
	for (const [key, value] of Object.entries(record)) {
		if (value && typeof value === "object") {
			insertAllEntities(value, schemas, sql, state, [...path, key], config);
		}
	}

	// THEN insert this entity
	if (isEntity(obj, config)) {
		const entityType = inferEntityType(obj, path, config);
		if (schemas[entityType]) {
			const entityId = insertEntityRecord(
				obj,
				entityType,
				schemas[entityType],
				sql,
				state,
				config,
			);

			// Track relationships for junction tables
			if (entityId !== null) {
				trackEntityRelationships(
					record,
					entityType,
					entityId,
					schemas,
					state,
					config,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Insert a single entity record
// ---------------------------------------------------------------------------

function insertEntityRecord(
	entity: unknown,
	tableName: string,
	schema: TableSchema,
	sql: SqlExec,
	state: InsertionState,
	config?: DomainConfig,
): number | string | null {
	// Dedup: skip if already processed (by object reference)
	const entityMap = state.processedEntities.get(tableName) ?? new Map();
	if (entityMap.has(entity)) {
		return entityMap.get(entity)!;
	}

	const rowData = mapEntityToSchema(entity, schema, state, config);
	if (Object.keys(rowData).length === 0) return null;

	const columns = Object.keys(rowData);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((col) => rowData[col]);
	const record = entity as Record<string, unknown>;

	let insertedId: number | string | null = null;

	try {
		if (
			record.id !== undefined &&
			(typeof record.id === "string" || typeof record.id === "number")
		) {
			// Entity has its own ID — use INSERT OR REPLACE
			insertedId = record.id as string | number;
			sql.exec(
				`INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
				...values,
			);
		} else {
			// Auto-increment ID
			sql.exec(
				`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
				...values,
			);
			try {
				const idRow = sql
					.exec(`SELECT last_insert_rowid() as lid`)
					.toArray();
				insertedId = (idRow[0]?.lid as number) ?? null;
			} catch {
				insertedId = null;
			}
		}
		state.totalRows++;
	} catch (err) {
		// NEVER silently lose data — record the error
		const msg = err instanceof Error ? err.message : String(err);
		state.errors.push(`INSERT into ${tableName} failed: ${msg}`);
	}

	// Track by object reference for FK resolution
	if (insertedId !== null) {
		entityMap.set(entity, insertedId);
		state.processedEntities.set(tableName, entityMap);
	}

	return insertedId;
}

// ---------------------------------------------------------------------------
// Map entity fields to schema columns
// ---------------------------------------------------------------------------

/** Outcome of one column-resolution strategy: `{ value }` = use it,
 *  `"skip-column"` = omit the column entirely, `null` = try the next strategy. */
type ColumnResolution = { value: unknown } | "skip-column" | null;

/** Auto-increment integer PKs are assigned by SQLite, never mapped from data. */
function isAutoIncrementPk(columnName: string, schema: TableSchema): boolean {
	return columnName === "id" && schema.columns[columnName].includes("AUTOINCREMENT");
}

/** Strategy 1: a `<base>_json` column gets the JSON-stringified `<base>` object. */
function resolveJsonColumn(
	columnName: string,
	record: Record<string, unknown>,
	config?: DomainConfig,
): ColumnResolution {
	if (!columnName.endsWith("_json")) return null;
	const originalKey = findOriginalKey(record, columnName.slice(0, -5), config);
	if (
		originalKey &&
		record[originalKey] !== undefined &&
		typeof record[originalKey] === "object" &&
		record[originalKey] !== null
	) {
		return { value: JSON.stringify(record[originalKey]) };
	}
	return null;
}

/** Strategy 2: direct key match (camelCase→snake_case), with boolean coercion.
 *  Entity values belong to the FK/junction strategies: an array of entities
 *  skips the column; a single nested entity falls through (returns null). */
function resolveDirectColumn(
	columnName: string,
	record: Record<string, unknown>,
	config?: DomainConfig,
): ColumnResolution {
	const originalKey = findOriginalKey(record, columnName, config);
	if (!originalKey || record[originalKey] === undefined) return null;

	let value = record[originalKey];
	if (typeof value === "boolean") value = value ? 1 : 0;

	if (Array.isArray(value) && value.length > 0 && isEntity(value[0], config)) {
		return "skip-column";
	}
	if (value && typeof value === "object" && !Array.isArray(value) && isEntity(value, config)) {
		return null;
	}
	return { value };
}

/** Strategy 3: a `<base>_id` column resolves to the related entity's inserted id
 *  (the processed-entity registry first, else the entity's own `id`). */
function resolveForeignKey(
	columnName: string,
	record: Record<string, unknown>,
	state: InsertionState,
	config?: DomainConfig,
): ColumnResolution {
	if (!columnName.endsWith("_id")) return null;
	const originalKey = findOriginalKey(record, columnName.slice(0, -3), config);
	if (!originalKey || !record[originalKey] || typeof record[originalKey] !== "object") {
		return null;
	}
	const nestedEntity = record[originalKey];

	for (const [, entityMap] of state.processedEntities.entries()) {
		if (entityMap.has(nestedEntity)) {
			return { value: entityMap.get(nestedEntity)! };
		}
	}

	const ownId = (nestedEntity as Record<string, unknown>).id;
	return ownId !== undefined ? { value: ownId } : null;
}

/** Strategy 4: a `<prefix>_<subfield>` column resolves to `record[prefix][subfield]`. */
function resolveNestedField(
	columnName: string,
	record: Record<string, unknown>,
	config?: DomainConfig,
): ColumnResolution {
	if (!columnName.includes("_") || columnName.endsWith("_json") || columnName.endsWith("_id")) {
		return null;
	}
	const parts = columnName.split("_");
	for (let splitPoint = 1; splitPoint < parts.length; splitPoint++) {
		const baseKey = parts.slice(0, splitPoint).join("_");
		const subKey = parts.slice(splitPoint).join("_");
		const originalKey = findOriginalKey(record, baseKey, config);
		if (
			originalKey &&
			record[originalKey] &&
			typeof record[originalKey] === "object" &&
			!Array.isArray(record[originalKey])
		) {
			const nestedObj = record[originalKey] as Record<string, unknown>;
			const originalSubKey = findOriginalKey(nestedObj, subKey, config);
			if (originalSubKey && nestedObj[originalSubKey] !== undefined) {
				let value = nestedObj[originalSubKey];
				if (typeof value === "boolean") value = value ? 1 : 0;
				return { value };
			}
		}
	}
	return null;
}

/** Resolve a column's value by running the strategies in priority order. */
function resolveColumn(
	columnName: string,
	record: Record<string, unknown>,
	state: InsertionState,
	config?: DomainConfig,
): ColumnResolution {
	return (
		resolveJsonColumn(columnName, record, config) ??
		resolveDirectColumn(columnName, record, config) ??
		resolveForeignKey(columnName, record, state, config) ??
		resolveNestedField(columnName, record, config)
	);
}

export function mapEntityToSchema(
	obj: unknown,
	schema: TableSchema,
	state: InsertionState,
	config?: DomainConfig,
): Record<string, unknown> {
	const rowData: Record<string, unknown> = {};
	const record = obj as Record<string, unknown>;

	if (!obj || typeof obj !== "object") {
		if (schema.columns.value) rowData.value = obj;
		return rowData;
	}

	for (const columnName of Object.keys(schema.columns)) {
		if (isAutoIncrementPk(columnName, schema)) continue;

		const resolution = resolveColumn(columnName, record, state, config);
		if (resolution === "skip-column" || resolution === null) continue;

		if (resolution.value !== null && resolution.value !== undefined) {
			rowData[columnName] = resolution.value;
		}
	}

	return rowData;
}

// ---------------------------------------------------------------------------
// Track relationships for junction tables
// ---------------------------------------------------------------------------

export function trackEntityRelationships(
	entity: Record<string, unknown>,
	entityType: string,
	entityId: number | string,
	schemas: Record<string, TableSchema>,
	state: InsertionState,
	config?: DomainConfig,
): void {
	for (const [key, value] of Object.entries(entity)) {
		// Unwrap wrapper objects
		let items: unknown[] | null = null;

		if (Array.isArray(value) && value.length > 0) {
			items = value;
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			const wrapper = value as Record<string, unknown>;
			if (wrapper.nodes && Array.isArray(wrapper.nodes)) {
				items = wrapper.nodes;
			} else if (wrapper.edges && Array.isArray(wrapper.edges)) {
				items = (wrapper.edges as Array<Record<string, unknown>>)
					.map((e) => e.node)
					.filter(Boolean);
			} else if (wrapper.rows && Array.isArray(wrapper.rows)) {
				items = wrapper.rows;
			}
		}

		// 1:1 nested entities use direct FK columns — no junction table
		if (!items || items.length === 0) continue;

		const firstItem = items.find((item) => isEntity(item, config));
		if (!firstItem) continue;

		const relatedType = inferEntityType(firstItem, [key], config);
		const junctionName = [entityType, relatedType].sort().join("_");
		if (!schemas[junctionName]) continue;

		const pairs = state.relationshipData.get(junctionName) ?? new Set<string>();

		for (const item of items) {
			if (!isEntity(item, config)) continue;
			const relatedId = getEntityId(item, relatedType, state);
			if (isValidId(entityId) && isValidId(relatedId)) {
				const [sortedType1] = [entityType, relatedType].sort();
				const id1 = sortedType1 === entityType ? entityId : relatedId;
				const id2 = sortedType1 === entityType ? relatedId : entityId;
				pairs.add(`${id1}::${id2}`);
			}
		}

		state.relationshipData.set(junctionName, pairs);
	}
}

// ---------------------------------------------------------------------------
// Phase 2: Junction table records
// ---------------------------------------------------------------------------

function insertJunctionRecords(
	schemas: Record<string, TableSchema>,
	sql: SqlExec,
	state: InsertionState,
): void {
	for (const [junctionName, pairs] of state.relationshipData.entries()) {
		if (!schemas[junctionName]) continue;

		const columns = Object.keys(schemas[junctionName].columns).filter((c) =>
			c.endsWith("_id"),
		);
		if (columns.length < 2) continue;

		for (const pairKey of pairs) {
			const [id1Str, id2Str] = pairKey.split("::");
			const id1 = isNaN(Number(id1Str)) ? id1Str : Number(id1Str);
			const id2 = isNaN(Number(id2Str)) ? id2Str : Number(id2Str);

			try {
				sql.exec(
					`INSERT OR IGNORE INTO ${junctionName} (${columns[0]}, ${columns[1]}) VALUES (?, ?)`,
					id1,
					id2,
				);
				state.totalRows++;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				state.errors.push(
					`INSERT into junction ${junctionName} failed: ${msg}`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Simple row insertion (fallback schemas)
// ---------------------------------------------------------------------------

function insertSimpleRow(
	obj: unknown,
	tableName: string,
	schema: TableSchema,
	sql: SqlExec,
	state: InsertionState,
	config?: DomainConfig,
): void {
	const rowData = mapObjectToSimpleSchema(obj, schema, config);
	if (
		Object.keys(rowData).length === 0 &&
		!(tableName === "scalar_data" && obj === null)
	) {
		return;
	}

	const columns = Object.keys(rowData);
	const placeholders = columns.map(() => "?").join(", ");
	const values = columns.map((col) => rowData[col]);

	try {
		sql.exec(
			`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
			...values,
		);
		state.totalRows++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		state.errors.push(`INSERT into ${tableName} failed: ${msg}`);
	}
}

function mapObjectToSimpleSchema(
	obj: unknown,
	schema: TableSchema,
	config?: DomainConfig,
): Record<string, unknown> {
	const rowData: Record<string, unknown> = {};

	if (obj === null || typeof obj !== "object") {
		if (schema.columns.value) {
			rowData.value = obj;
		} else if (Object.keys(schema.columns).length > 0) {
			const firstCol = Object.keys(schema.columns)[0];
			rowData[firstCol] = obj;
		}
		return rowData;
	}

	const record = obj as Record<string, unknown>;

	for (const columnName of Object.keys(schema.columns)) {
		if (columnName.endsWith("_json")) {
			const baseKey = columnName.slice(0, -5);
			const originalKey = findOriginalKey(record, baseKey, config);
			if (originalKey && record[originalKey] !== undefined) {
				rowData[columnName] = JSON.stringify(record[originalKey]);
			}
		} else {
			const originalKey = findOriginalKey(record, columnName, config);
			if (originalKey && record[originalKey] !== undefined) {
				const val = record[originalKey];
				if (typeof val === "boolean") {
					rowData[columnName] = val ? 1 : 0;
				} else if (typeof val === "object" && val !== null) {
					rowData[columnName] = JSON.stringify(val);
				} else {
					rowData[columnName] = val;
				}
			}
		}
	}

	return rowData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEntityId(
	entity: unknown,
	entityType: string,
	state: InsertionState,
): number | string | null {
	const entityMap = state.processedEntities.get(entityType);
	return entityMap?.get(entity) ?? null;
}
