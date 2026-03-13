/**
 * Canonical staging metadata — a machine-readable signal in every staged response.
 *
 * Every tool that stages data (specific tools, Code Mode auto-staging, etc.)
 * includes `_staging: StagingMetadata` in structuredContent so clients and
 * models can reliably detect and use staged data without regex parsing.
 */
/**
 * Build a StagingMetadata object from staging results.
 */
export function buildStagingMetadata(opts) {
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
//# sourceMappingURL=staging-metadata.js.map