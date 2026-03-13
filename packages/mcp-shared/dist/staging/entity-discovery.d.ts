/**
 * Entity Discovery — detects entities in JSON data, infers their types,
 * and records parent→child relationships.
 *
 * This is the SINGLE SOURCE OF TRUTH for `isEntity()` and `inferEntityType()`.
 * Both schema-builder and data-inserter import from here, eliminating the
 * bug class where the two engines disagree on entity types.
 */
import type { DomainConfig } from "./types";
export interface DiscoveryResult {
    /** entityType → array of entity objects */
    entities: Map<string, unknown[]>;
    /** fromTable → Set<toTable> (many-to-many relationships only) */
    relationships: Map<string, Set<string>>;
}
export declare function isEntity(obj: unknown, config?: DomainConfig): boolean;
export declare function inferEntityType(obj: unknown, path: string[], config?: DomainConfig): string;
export declare function discoverEntities(data: unknown, config?: DomainConfig): DiscoveryResult;
//# sourceMappingURL=entity-discovery.d.ts.map