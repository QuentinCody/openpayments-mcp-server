/**
 * Shared string normalization utilities for JSON → SQLite conversion.
 *
 * Extracted from 6 per-server copies into a single source of truth.
 * All functions are pure (no state) and deterministic.
 */
import type { DomainConfig } from "./types";
export declare function sanitizeTableName(name: string): string;
export declare function sanitizeColumnName(name: string, config?: DomainConfig): string;
export declare function singularize(word: string, config?: DomainConfig): string;
export declare function getSQLiteType(value: unknown): string;
export declare function resolveColumnTypes(columnTypes: Record<string, Set<string>>): Record<string, string>;
export declare function ensureIdColumn(columns: Record<string, string>): void;
export declare function hasScalarFields(obj: unknown): boolean;
export declare function findOriginalKey(obj: Record<string, unknown>, sanitizedKey: string, config?: DomainConfig): string | null;
export declare function isValidId(id: unknown): boolean;
//# sourceMappingURL=normalizer.d.ts.map