// Pure transforms behind RestStagingDO.handleSchema().
//
// handleSchema() reads SQLite (PRAGMA, _inferred_schema, _column_profiles,
// _staging_metadata) — that part stays coupled to the Durable Object. Everything
// that shapes those raw rows into the get_schema response is pure and lives here
// so it can be unit-tested without the `cloudflare:workers` import (same pattern
// as ./schema-hints).
import type { InferredSchema, TableProfile } from "./schema-inference";
import type { TableRelationship } from "./staging-metadata";

/** Provenance metadata surfaced in get_schema output, normalized from a raw _staging_metadata row. */
export interface ProvenanceRow {
	tool_name: string | null;
	server_name: string | null;
	api_url: string | null;
	staged_at: string | null;
	input_rows: number | null;
	stored_rows: number | null;
	failed_rows: number | null;
}

export interface ColumnMetaEntry {
	jsonShape?: string;
	pipeDelimited?: boolean;
}

/** Index inferred-schema columns carrying json_shape / pipe-delimited hints, keyed `table.column`. */
export function buildColumnMeta(
	inferredSchema: InferredSchema | undefined,
): Map<string, ColumnMetaEntry> {
	const columnMeta = new Map<string, ColumnMetaEntry>();
	if (!inferredSchema) return columnMeta;
	for (const table of inferredSchema.tables) {
		for (const col of table.columns) {
			if (col.jsonShape || col.pipeDelimited) {
				columnMeta.set(`${table.name}.${col.name}`, {
					jsonShape: col.jsonShape,
					pipeDelimited: col.pipeDelimited,
				});
			}
		}
	}
	return columnMeta;
}

/** Index persisted column profiles by table name. */
export function buildProfileByTable(
	columnProfiles: TableProfile[] | undefined,
): Map<string, Record<string, unknown>> {
	const profileByTable = new Map<string, Record<string, unknown>>();
	if (!columnProfiles) return profileByTable;
	for (const tp of columnProfiles) {
		profileByTable.set(
			tp.table,
			tp.columns as unknown as Record<string, unknown>,
		);
	}
	return profileByTable;
}

export interface ColumnDescriptor {
	name: string;
	type: string;
	not_null: boolean;
	primary_key: boolean;
	json_shape?: string;
	searchable_array?: boolean;
	profile?: unknown;
}

/** Shape one get_schema column descriptor from a raw PRAGMA table_info row + hint/profile lookups. */
export function buildColumnDescriptor(
	rawCol: Record<string, unknown>,
	tableName: string,
	columnMeta: Map<string, ColumnMetaEntry>,
	profileByTable: Map<string, Record<string, unknown>>,
): ColumnDescriptor {
	const colName = rawCol.name as string;
	const meta = columnMeta.get(`${tableName}.${colName}`);
	const tableProfiles = profileByTable.get(tableName) as
		| Record<string, Record<string, unknown>>
		| undefined;
	const colProfile = tableProfiles?.[colName];
	return {
		name: colName,
		type: rawCol.type as string,
		not_null: rawCol.notnull === 1,
		primary_key: rawCol.pk === 1,
		...(meta?.jsonShape ? { json_shape: meta.jsonShape } : {}),
		...(meta?.pipeDelimited ? { searchable_array: true } : {}),
		...(colProfile ? { profile: colProfile } : {}),
	};
}

export interface RelationshipWithJoin extends TableRelationship {
	join_sql: string;
}

/** Attach a sample JOIN SQL string to each relationship, resolving the parent key column. */
export function buildRelationshipJoins(
	relationships: TableRelationship[],
	inferredSchema: InferredSchema | undefined,
): RelationshipWithJoin[] {
	return relationships.map((rel) => {
		// Parent PK is _rowid when the parent carries its own data "id" column, else "id".
		const parentTable = inferredSchema?.tables.find(
			(t) => t.name === rel.parent_table,
		);
		const parentHasDataId =
			parentTable?.columns.some((c) => c.name === "id") ?? false;
		const parentKeyCol = parentHasDataId ? "_rowid" : "id";
		return {
			...rel,
			join_sql: `SELECT p.*, c.* FROM "${rel.parent_table}" p JOIN "${rel.child_table}" c ON c.parent_id = p.${parentKeyCol}`,
		};
	});
}

/** Normalize a raw _staging_metadata row into a typed ProvenanceRow (string/number fields only). */
export function normalizeProvenance(
	rawRow: Record<string, unknown> | undefined,
): ProvenanceRow | undefined {
	if (rawRow === undefined) return undefined;
	const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
	const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
	return {
		tool_name: str(rawRow.tool_name),
		server_name: str(rawRow.server_name),
		api_url: str(rawRow.api_url),
		staged_at: str(rawRow.staged_at),
		input_rows: num(rawRow.input_rows),
		stored_rows: num(rawRow.stored_rows),
		failed_rows: num(rawRow.failed_rows),
	};
}
