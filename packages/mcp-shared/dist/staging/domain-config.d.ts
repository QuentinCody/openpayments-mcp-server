/**
 * Pre-built DomainConfig objects for each server that uses Tier 2 normalization.
 *
 * All per-server customization is expressed here as configuration — no code forks.
 */
import type { DomainConfig } from "./types";
export declare const DEFAULT_CONFIG: DomainConfig;
export declare const CIVIC_CONFIG: DomainConfig;
export declare const DGIDB_CONFIG: DomainConfig;
export declare const OPENTARGETS_CONFIG: DomainConfig;
export declare const RCSB_PDB_CONFIG: DomainConfig;
/**
 * Look up a DomainConfig by server name.
 * Returns DEFAULT_CONFIG if no specific config is registered.
 */
export declare function getDomainConfigByName(serverName: string): DomainConfig;
//# sourceMappingURL=domain-config.d.ts.map