/**
 * GraphQL schema-discovery runtime for Code Mode — the `<prefix>_search` tool
 * plus the shared "introspection unavailable" fallback.
 *
 * Split out of graphql-execute-tool.ts (line cap) and the home for graceful
 * degradation: some GraphQL APIs disable introspection in production (e.g. NCI
 * PDC's Apollo server sets `introspection: false`). Without this, the very first
 * thing every `_execute`/`_search` call does — fetch the schema — throws, and the
 * tool is 100% unusable even though `gql.query()` against the real API works fine.
 * Here we treat an introspection failure as "schema discovery unavailable" and let
 * direct queries proceed.
 */

import { z } from "zod";
import {
	fetchIntrospection,
	type GraphqlFetchFn,
	type TrimmedIntrospection,
} from "./graphql-introspection";
import { searchTrimmedIntrospection } from "./graphql-search";
import { createCodeModeError, ErrorCodes } from "./response";

/**
 * Message surfaced (as `schema.note` inside the isolate and as the `_search`
 * tool's text) when an upstream disables GraphQL introspection. Kept generic so
 * it reads correctly for any such API, not just PDC.
 */
export const SCHEMA_DISCOVERY_UNAVAILABLE =
	"Schema discovery is unavailable — this API has GraphQL introspection disabled. " +
	"Write queries with gql.query(...) using field names from the API's published schema docs; " +
	"schema.* helpers return empty and schema.available is false.";

/**
 * Empty schema injected into the isolate when introspection is unavailable, so
 * the `schema.*` helpers exist (returning empty) instead of the isolate throwing.
 */
export const EMPTY_SCHEMA: TrimmedIntrospection = {
	queryType: { name: "Query" },
	types: [],
};

/** The slice of the execute tool's introspection cache these helpers read/write. */
export interface IntrospectionCache {
	introspection: TrimmedIntrospection | undefined;
	/** Set once when introspection is disabled upstream so we don't re-fetch. */
	introspectionUnavailable?: boolean;
}

/**
 * Fetch introspection once, into the shared cache. If the upstream disables it,
 * cache the failure (so we don't retry every call) and leave `introspection`
 * undefined — callers treat that as "unavailable" (pre-flight skipped in the
 * proxy, `schema.*` helpers empty). A transient failure is also cached; Workers
 * are ephemeral, so a later cold start re-attempts, and `gql.query()` works
 * either way.
 */
export async function ensureIntrospectionCached(
	cache: IntrospectionCache,
	gqlFetch: GraphqlFetchFn,
): Promise<void> {
	if (cache.introspection || cache.introspectionUnavailable) return;
	try {
		cache.introspection = await fetchIntrospection(gqlFetch);
	} catch {
		cache.introspectionUnavailable = true;
	}
}

/**
 * Register the `<prefix>_search` schema-discovery tool (#3). Shares the execute
 * tool's lazy introspection cache (no second introspection fetch), letting a model
 * find REAL query roots / fields before writing a `_execute` query — closing the
 * prior gap where guessed GraphQL fields produced invalid-query / empty results.
 * When the API disables introspection, returns a clear "unavailable" note instead
 * of erroring, pointing the caller at `<prefix>_execute` (which still works).
 */
export function registerGraphqlSearchTool(
	server: { tool: (...args: unknown[]) => void },
	opts: {
		prefix: string;
		apiName: string;
		gqlFetch: GraphqlFetchFn;
		cache: IntrospectionCache;
	},
): void {
	const { prefix, apiName, gqlFetch, cache } = opts;
	server.tool(
		`${prefix}_search`,
		`Search the ${apiName} GraphQL schema for the query roots, types, and fields matching your keywords — so you write a ${prefix}_execute query with REAL field names instead of guessing. Call this FIRST when you don't already know the schema. Returns top-level entry points plus matching Type.field signatures with their arguments and return types.`,
		{
			query: z
				.string()
				.describe(
					'Keywords to find in the schema — a gene, disease, drug, entity, or a field name like "association". Empty string browses the query roots.',
				),
			max_results: z
				.number()
				.int()
				.positive()
				.max(40)
				.optional()
				.describe("Max matches to return (default 12)."),
		},
		async (input: { query?: string; max_results?: number }) => {
			try {
				await ensureIntrospectionCached(cache, gqlFetch);
				if (!cache.introspection) {
					// Upstream disables introspection — no schema to search. Point the
					// caller at the execute tool (gql.query still works).
					return {
						content: [{ type: "text", text: SCHEMA_DISCOVERY_UNAVAILABLE }],
						structuredContent: {
							success: true,
							query: input.query ?? "",
							schema: apiName,
							schema_available: false,
						},
					};
				}
				const text = searchTrimmedIntrospection(
					cache.introspection,
					input.query ?? "",
					input.max_results ?? 12,
				);
				return {
					content: [{ type: "text", text }],
					structuredContent: {
						success: true,
						query: input.query ?? "",
						schema: apiName,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return createCodeModeError(
					ErrorCodes.UNKNOWN_ERROR,
					`${prefix}_search failed: ${message}`,
				);
			}
		},
	);
}
