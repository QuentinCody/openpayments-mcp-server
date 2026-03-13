/**
 * Schema Builder — generates CREATE TABLE DDL from discovered entities.
 *
 * Takes the output of entity-discovery (entities map + relationships map)
 * and produces a Record<tableName, TableSchema> with:
 *   - Entity tables (columns inferred from sampling all instances)
 *   - Junction tables (for many-to-many relationships)
 *   - Proper FK type matching (TEXT vs INTEGER based on referenced PK)
 */
import type { DomainConfig, TableSchema } from "./types";
/**
 * Build table schemas from discovered entities and their relationships.
 */
export declare function buildSchemas(entities: Map<string, unknown[]>, relationships: Map<string, Set<string>>, config?: DomainConfig): Record<string, TableSchema>;
/**
 * Build a fallback schema for simple / non-entity data.
 */
export declare function buildFallbackSchema(data: unknown): Record<string, TableSchema>;
//# sourceMappingURL=schema-builder.d.ts.map