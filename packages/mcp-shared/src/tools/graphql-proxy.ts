/**
 * Hidden __graphql_proxy tool — routes V8 isolate gql.query() calls
 * through the server's GraphQL fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It executes GraphQL queries, handles errors, and auto-stages
 * large responses via stageToDoAndRespond().
 */

import { z } from "zod";
import type { ToolEntry } from "../registry/types";
import type { GraphqlFetchFn } from "../codemode/graphql-introspection";
import { shouldStage, stageToDoAndRespond, type StageResult } from "../staging/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max size (bytes) for a single property to be preserved in the staging envelope. */
const ENVELOPE_SCALAR_LIMIT = 1024;

/**
 * Copy small scalar properties from the original response onto the
 * staging metadata object so LLM code can read them without a round-trip.
 */
function preserveEnvelopeScalars(
	original: unknown,
	staging: Record<string, unknown>,
): void {
	if (!original || typeof original !== "object" || Array.isArray(original)) {
		return;
	}
	for (const [key, value] of Object.entries(original)) {
		if (key in staging) continue;
		try {
			const serialized = JSON.stringify(value);
			if (serialized !== undefined && serialized.length <= ENVELOPE_SCALAR_LIMIT) {
				staging[key] = value;
			}
		} catch { /* best-effort: Skip non-serializable values */ }
	}
}

/**
 * Build a human-readable summary of staged tables.
 */
function buildStagedTableSummary(staged: StageResult): string {
	const tables = staged.tablesCreated;
	const rowCounts = staged._staging?.table_row_counts as
		| Record<string, number>
		| undefined;
	if (!tables || tables.length === 0) {
		return `${staged.totalRows ?? 0} rows`;
	}
	if (tables.length === 1) {
		const rows = rowCounts?.[tables[0]] ?? staged.totalRows ?? 0;
		return `table "${tables[0]}" [${rows} rows]`;
	}
	const details = tables
		.map((t) => {
			const rows = rowCounts?.[t];
			return rows !== undefined ? `${t} [${rows}]` : t;
		})
		.join(", ");
	return `${tables.length} tables: ${details}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface GraphqlProxyToolOptions {
	/** Function to execute GraphQL queries on the host */
	gqlFetch: GraphqlFetchFn;
	/** DO namespace for auto-staging large responses */
	doNamespace?: unknown;
	/** Prefix for data access IDs (e.g., "pharos") */
	stagingPrefix: string;
	/** Byte threshold for auto-staging (default from shouldStage) */
	stagingThreshold?: number;
}

interface StagingConfig {
	doNamespace: unknown;
	prefix: string;
	threshold: number | undefined;
}

/**
 * Try to auto-stage a large response into the DO.
 * Returns the staging envelope if staged, or undefined if not applicable.
 */
async function tryAutoStage(
	resultData: unknown,
	responseBytes: number,
	config: StagingConfig,
	sessionId: string | undefined,
): Promise<Record<string, unknown> | undefined> {
	if (!config.doNamespace || !shouldStage(responseBytes, config.threshold)) {
		return undefined;
	}

	const staged = await stageToDoAndRespond(
		resultData,
		config.doNamespace as Parameters<typeof stageToDoAndRespond>[1],
		config.prefix,
		undefined,
		undefined,
		config.prefix,
		sessionId,
	);
	const tableDetail = buildStagedTableSummary(staged);
	const envelope: Record<string, unknown> = {
		__staged: true,
		data_access_id: staged.dataAccessId,
		schema: staged.schema,
		tables_created: staged.tablesCreated,
		total_rows: staged.totalRows,
		_staging: staged._staging,
		message: `Response auto-staged (${(responseBytes / 1024).toFixed(1)}KB → ${tableDetail}). Use api.query("${staged.dataAccessId}", sql) in-band, or return this object for the caller to use the query_data tool.`,
	};

	preserveEnvelopeScalars(resultData, envelope);
	return envelope;
}

/**
 * Execute a GraphQL query and return the result, staging if needed.
 */
async function executeAndMaybeStage(
	gqlFetch: GraphqlFetchFn,
	query: string,
	variables: Record<string, unknown> | undefined,
	staging: StagingConfig,
	sessionId: string | undefined,
): Promise<unknown> {
	const response = await gqlFetch(query, variables);

	// GraphQL errors without data — return error
	if (response.errors && !response.data) {
		const messages = response.errors.map((e) => e.message).join("; ");
		return { __gql_error: true, message: messages, errors: response.errors };
	}

	// Always return response.data directly for consistent shape.
	// If there are partial errors alongside data, attach them as a
	// non-enumerable __errors property so they don't pollute staging
	// but isolate code can still inspect them via result.__errors.
	const resultData = response.data ?? {};

	const responseBytes = JSON.stringify(resultData).length;
	const staged = await tryAutoStage(resultData, responseBytes, staging, sessionId);
	const output = staged ?? resultData;

	// Attach partial errors if present (errors-only case is handled above)
	if (response.errors && output && typeof output === "object") {
		(output as Record<string, unknown>).__errors = response.errors;
	}

	return output;
}

/**
 * Build the handler function for the __graphql_proxy tool.
 */
function buildHandler(
	gqlFetch: GraphqlFetchFn,
	staging: StagingConfig,
): (input: Record<string, unknown>, ctx: import("../registry/types").ToolContext) => Promise<unknown> {
	return async (input, ctx) => {
		const query = String(input.query || "");
		const variables = input.variables as Record<string, unknown> | undefined;

		if (!query) {
			return { __gql_error: true, message: "query is required", errors: [] };
		}

		try {
			return await executeAndMaybeStage(gqlFetch, query, variables, staging, ctx?.sessionId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { __gql_error: true, message, errors: [{ message }] };
		}
	};
}

/**
 * Create the hidden __graphql_proxy tool entry.
 */
export function createGraphqlProxyTool(options: GraphqlProxyToolOptions): ToolEntry {
	const staging: StagingConfig = {
		doNamespace: options.doNamespace,
		prefix: options.stagingPrefix,
		threshold: options.stagingThreshold,
	};

	return {
		name: "__graphql_proxy",
		description: "Route GraphQL queries from V8 isolate through server fetch layer. Internal only.",
		hidden: true,
		schema: {
			query: z.string(),
			variables: z.record(z.string(), z.unknown()).optional(),
		},
		handler: buildHandler(options.gqlFetch, staging),
	};
}
