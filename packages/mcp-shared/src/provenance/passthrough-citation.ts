// Verifiable provenance for raw GraphQL passthrough tools
// (`<server>_graphql_query`). Mirrors what the Code Mode `*_execute` tools
// attach via buildCitation, so a query routed through a passthrough still
// carries `_meta.citation` and shows up in the chat Sources strip.
import {
	buildCitation,
	type Citation,
	type SourceDescriptor,
} from "./provenance";

export interface PassthroughCitationArgs {
	/** Source descriptor; when absent, no citation is produced (returns {}). */
	source?: SourceDescriptor;
	/** Server alias, e.g. "civic". */
	server: string;
	/** Passthrough tool name, e.g. "civic_graphql_query". */
	tool: string;
	/** The request (query + variables) — hashed into query_hash. */
	query: unknown;
	/** The result bytes being cited (inline result, or the staged data). */
	result: unknown;
	/** Override only when the caller puts the inline result at the response root. */
	resultScope?: "structured_content:data" | "structured_content:root_without_meta";
	recordCount?: number;
	dataAccessId?: string;
}

/**
 * Build the `_meta.citation` envelope for a passthrough result. Returns `{}`
 * when the server declares no source descriptor, so callers can spread it
 * unconditionally:
 *
 *   const cite = await buildPassthroughCitation({ source, server, tool, query, result });
 *   structuredContent: { ...data, _meta: { ...cite } }
 */
export async function buildPassthroughCitation(
	args: PassthroughCitationArgs,
): Promise<{ citation?: Citation }> {
	if (!args.source) return {};
	const citation = await buildCitation({
		source: args.source,
		server: args.server,
		tool: args.tool,
		query: args.query,
		queryScope: "tool_arguments",
		result: args.result,
		resultScope: args.dataAccessId
			? "staged:full_result"
			: (args.resultScope ?? "structured_content:data"),
		retrievedAt: new Date().toISOString(),
		recordCount: args.recordCount,
		dataAccessId: args.dataAccessId,
	});
	return { citation };
}
