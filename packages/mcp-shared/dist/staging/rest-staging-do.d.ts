/**
 * REST Staging Durable Object base class.
 *
 * Generalizes the clinicaltrialsgov JsonToSqlDO pattern.
 * Subclasses override `getSchemaHints()` to customize inference.
 *
 * New hooks for the consolidated staging engine:
 *   - `getDomainConfig()` — return a DomainConfig for Tier 2 normalization
 *   - `getStagingContext()` — return request metadata for config cascade
 *   - `useConsolidatedEngine()` — opt-in to the new StagingEngine
 */
import { DurableObject } from "cloudflare:workers";
import { ChunkingEngine } from "./chunking";
import { type SchemaHints } from "./schema-inference";
import type { DomainConfig, StagingContext, StagingHints } from "./types";
export declare class RestStagingDO extends DurableObject {
    protected chunking: ChunkingEngine;
    /** Override in subclass to provide domain-specific schema hints (Tier 1) */
    protected getSchemaHints(_data: unknown): SchemaHints | undefined;
    /**
     * Override in subclass to return a DomainConfig for Tier 2 normalization.
     * When this returns non-undefined and useConsolidatedEngine() returns true,
     * the consolidated StagingEngine is used instead of the Tier 1 pipeline.
     */
    protected getDomainConfig(): DomainConfig | undefined;
    /**
     * Override in subclass to provide request metadata for config cascade.
     */
    protected getStagingContext(_request: Request): StagingContext | undefined;
    /**
     * Override in subclass to return staging hints for the consolidated engine.
     */
    protected getStagingHints(_data: unknown): StagingHints | undefined;
    /**
     * Override to return true to opt-in to the consolidated staging engine.
     * Default is false for backward compatibility.
     */
    protected useConsolidatedEngine(): boolean;
    fetch(request: Request): Promise<Response>;
    /**
     * Store provenance metadata about how/when data was staged.
     */
    private storeProvenance;
    /**
     * Update provenance with row counts after materialization.
     */
    private updateProvenanceRowCounts;
    /**
     * Persist the inferred schema so handleSchema() can surface
     * relationships, jsonShape, and pipe-delimited column metadata.
     */
    private persistInferredSchema;
    /**
     * Extract parent→child relationships from an InferredSchema.
     */
    private extractRelationships;
    private handleProcess;
    private handleQuery;
    private handleQueryEnhanced;
    private handleSchema;
    /**
     * Register a staged data_access_id against a session.
     * Called on the __registry__ DO instance by stageToDoAndRespond().
     */
    private handleRegister;
    /**
     * List staged data_access_ids for a session.
     * Called on the __registry__ DO instance by get_schema when data_access_id is omitted.
     */
    private handleList;
    private jsonResponse;
}
//# sourceMappingURL=rest-staging-do.d.ts.map