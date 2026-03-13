/**
 * Canonical staging metadata — a machine-readable signal in every staged response.
 *
 * Every tool that stages data (specific tools, Code Mode auto-staging, etc.)
 * includes `_staging: StagingMetadata` in structuredContent so clients and
 * models can reliably detect and use staged data without regex parsing.
 */

/** Describes a parent→child table relationship created by child table extraction */
export interface TableRelationship {
	child_table: string;
	parent_table: string;
	/** Column in child table referencing parent (always "parent_id") */
	fk_column: string;
	/** Column in parent that contained the source array */
	source_column: string;
}

export interface StagingMetadata {
	/** Always true — discriminant for detection */
	staged: true;
	/** Unique ID to pass to query_data / get_schema tools */
	data_access_id: string;
	/** Tables created in SQLite */
	tables: string[];
	/** Primary table (usually the first / most important) */
	primary_table?: string;
	/**
	 * Total rows inserted across ALL tables (parent + child + junction).
	 * WARNING: This is NOT the entity count — use `primary_table_rows` for that.
	 */
	total_rows?: number;
	/**
	 * Number of rows in the primary (parent) table — represents the actual entity count.
	 * Use this when reporting "how many X were found" (e.g., 96 gene-drug interactions).
	 * `total_rows` may be much higher due to child/junction tables.
	 */
	primary_table_rows?: number;
	/** Row counts per table — use to understand data distribution across tables */
	table_row_counts?: Record<string, number>;
	/** Approximate payload size in bytes before staging */
	payload_size_bytes?: number;
	/** Tool name for querying staged data (e.g. "ctgov_query_data") */
	query_tool: string;
	/** Tool name for inspecting schema (e.g. "ctgov_get_schema") */
	schema_tool: string;
	/** Parent→child table relationships (from child table extraction) */
	relationships?: TableRelationship[];
}

/**
 * Build a StagingMetadata object from staging results.
 */
export function buildStagingMetadata(opts: {
	dataAccessId: string;
	tables: string[];
	primaryTable?: string;
	totalRows?: number;
	primaryTableRows?: number;
	tableRowCounts?: Record<string, number>;
	payloadSizeBytes?: number;
	toolPrefix: string;
	relationships?: TableRelationship[];
}): StagingMetadata {
	return {
		staged: true,
		data_access_id: opts.dataAccessId,
		tables: opts.tables,
		primary_table: opts.primaryTable ?? opts.tables[0],
		total_rows: opts.totalRows,
		...(opts.primaryTableRows != null
			? { primary_table_rows: opts.primaryTableRows }
			: {}),
		...(opts.tableRowCounts && Object.keys(opts.tableRowCounts).length > 0
			? { table_row_counts: opts.tableRowCounts }
			: {}),
		payload_size_bytes: opts.payloadSizeBytes,
		query_tool: `${opts.toolPrefix}_query_data`,
		schema_tool: `${opts.toolPrefix}_get_schema`,
		...(opts.relationships && opts.relationships.length > 0
			? { relationships: opts.relationships }
			: {}),
	};
}
