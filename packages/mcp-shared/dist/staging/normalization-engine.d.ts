/**
 * Normalization Engine — Tier 2 public facade.
 *
 * Composes entity-discovery + schema-builder + data-inserter into a single
 * call that takes raw JSON data and produces normalized SQLite tables.
 *
 * Usage:
 *   const engine = new NormalizationEngine(DGIDB_CONFIG);
 *   const result = engine.process(data, sql);
 */
import type { DomainConfig, SqlExec, StagingResult } from "./types";
export declare class NormalizationEngine {
    private readonly config?;
    constructor(config?: DomainConfig | undefined);
    /**
     * Process JSON data into normalized SQLite tables.
     *
     * 1. Discover entities and relationships
     * 2. Build table schemas (entity + junction)
     * 3. Create tables
     * 4. Insert data (children-first, then junctions)
     */
    process(data: unknown, sql: SqlExec): StagingResult;
}
//# sourceMappingURL=normalization-engine.d.ts.map