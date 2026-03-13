/**
 * Staging Engine — top-level orchestrator that picks the right tier
 * and runs the pipeline.
 *
 * Config cascade priority:
 *   1. Explicit StagingHints (hints.tier)
 *   2. Tool name / server name → DomainConfig lookup
 *   3. Auto-detection from response JSON structure
 *
 * Tier selection:
 *   Tier 2 (Full Normalization) — data contains nested entities with
 *     ID-bearing objects that themselves contain arrays of other entities.
 *   Tier 1 (Virtual Columns / flat inference) — everything else (flat arrays
 *     of objects, REST API responses, simple data).
 */
import type { DomainConfig, SqlExec, StagingContext, StagingHints, StagingResult } from "./types";
/**
 * Stage JSON data into SQLite tables, auto-detecting the appropriate tier.
 *
 * @param data      — The JSON response to stage
 * @param sql       — Cloudflare DO SQLite handle
 * @param context   — Optional request metadata (toolName, serverName)
 * @param hints     — Optional overrides for tier selection and schema
 * @param config    — Optional explicit DomainConfig (overrides context-based lookup)
 */
export declare function stageData(data: unknown, sql: SqlExec, context?: StagingContext, hints?: StagingHints, config?: DomainConfig): StagingResult;
//# sourceMappingURL=staging-engine.d.ts.map