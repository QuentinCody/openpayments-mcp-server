/**
 * Schema-hint merging — pure logic extracted from `rest-staging-do.ts` so it is
 * unit-testable in Node (the DO module imports `cloudflare:workers`, which a
 * Node/Vitest test cannot load). Client-provided hints override server defaults.
 */

import type { SchemaHints } from "./schema-inference";

/** Deduplicate composite indexes by their serialized column list. */
export function deduplicateCompositeIndexes(indexes: string[][]): string[][] {
	const seen = new Set<string>();
	const result: string[][] = [];
	for (const idx of indexes) {
		const key = idx.join(",");
		if (!seen.has(key)) {
			seen.add(key);
			result.push(idx);
		}
	}
	return result;
}

/** Shallow-merge two optional record hints (client wins per key); undefined when both absent. */
function mergeRecord<T extends Record<string, unknown>>(a: T | undefined, b: T | undefined): T | undefined {
	return a || b ? ({ ...a, ...b } as T) : undefined;
}

/** Deduplicated union of two optional string lists; undefined when both absent. */
function mergeStringSet(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	return a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;
}

/**
 * Merge server-side schema hints with client-provided hints. Client hints take
 * precedence for overlapping keys (tableName, columnTypes, maxRecursionDepth);
 * list-valued hints (indexes, exclude, …) are merged as deduplicated unions.
 * Returns undefined if both inputs are undefined.
 */
export function mergeSchemaHints(
	serverHints: SchemaHints | undefined,
	clientHints: SchemaHints | undefined,
): SchemaHints | undefined {
	if (!serverHints && !clientHints) return undefined;
	if (!serverHints) return clientHints;
	if (!clientHints) return serverHints;

	const compositeIndexes =
		serverHints.compositeIndexes || clientHints.compositeIndexes
			? deduplicateCompositeIndexes([
					...(serverHints.compositeIndexes ?? []),
					...(clientHints.compositeIndexes ?? []),
				])
			: undefined;

	return {
		tableName: clientHints.tableName ?? serverHints.tableName,
		columnTypes: mergeRecord(serverHints.columnTypes, clientHints.columnTypes),
		indexes: mergeStringSet(serverHints.indexes, clientHints.indexes),
		flatten: mergeRecord(serverHints.flatten, clientHints.flatten),
		exclude: mergeStringSet(serverHints.exclude, clientHints.exclude),
		skipChildTables: mergeStringSet(serverHints.skipChildTables, clientHints.skipChildTables),
		maxRecursionDepth: clientHints.maxRecursionDepth ?? serverHints.maxRecursionDepth,
		compositeIndexes,
	};
}
