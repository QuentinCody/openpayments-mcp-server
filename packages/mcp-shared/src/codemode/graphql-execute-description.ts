/**
 * GraphQL `<prefix>_execute` tool-description builder. Extracted from
 * graphql-execute-tool.ts (which hit the line cap). Takes a narrow input shape
 * (not the full options type) so there's no import cycle.
 */

export interface GraphqlDescriptionInput {
	prefix: string;
	apiName?: string;
	preamble?: string;
	fsDoNamespace?: unknown;
	/** True when the server wired a second REST upstream (restApiFetch) — surfaces
	 *  api.get/api.post in the tool description so the model knows they're live. */
	hasRestApi?: boolean;
}

/** Extract `//` comment lines from a preamble to include as SERVER NOTES. */
function extractPreambleNotes(preamble: string): string {
	return preamble
		.split("\n")
		.filter((line) => line.trim().startsWith("//"))
		.map((line) => line.trim().replace(/^\/\/\s?/, ""))
		.join("\n");
}

/**
 * Build the `<prefix>_execute` tool description. `apiSummary` is the GraphQL
 * schema summary (T2.2 — when introspection is available at registration this is
 * the real query-root/type/arg listing, otherwise a "use schema.queryRoot()"
 * placeholder).
 */
export function buildGraphqlExecuteDescription(
	input: GraphqlDescriptionInput,
	apiSummary: string,
): string {
	const { prefix, preamble, fsDoNamespace } = input;
	const name = input.apiName ?? prefix;

	return (
		`Execute JavaScript code against the ${name} GraphQL API. ` +
		`Code runs in a sandboxed V8 isolate with:\n` +
		`- gql.query(queryString, variables?) — execute GraphQL queries (returns data directly, e.g. result.gene not result.data.gene)\n` +
		`- schema.types(), schema.type(name), schema.search(query) — explore the schema\n` +
		`- schema.queryRoot() — list available query entry points with args\n` +
		`- schema.enumValues(name), schema.inputType(name) — inspect enums and input types\n` +
		`- console logging (log, warn, error, info) — captured output\n` +
		(input.hasRestApi
			? `- api.get(path, params), api.post(path, body, params) — REST calls to this server's secondary (non-GraphQL) API; large responses auto-stage like gql.query (see SERVER NOTES for the typed helpers)\n`
			: "") +
		(fsDoNamespace
			? `- fs.readFile(path), fs.writeFile(path, content), fs.readJSON(path), fs.writeJSON(path, data) — persistent virtual filesystem\n` +
				`- fs.readdir(path), fs.mkdir(path), fs.stat(path), fs.exists(path), fs.rm(path), fs.glob(pattern) — directory operations\n`
			: "") +
		(preamble
			? `\nDomain-specific helper functions and quirks are documented below.\n`
			: "") +
		`\nThe last expression or return value is the result.\n` +
		(apiSummary ? `\n${apiSummary}\n\n` : "\n") +
		`STAGING: Large responses (>30KB) are auto-staged into SQLite. When this happens, ` +
		`gql.query returns {__staged: true, data_access_id, schema, tables_created, total_rows, message}. ` +
		`Scalar properties from the original response are preserved on the staged object.\n\n` +
		`When staging occurs:\n` +
		`1. Check result.__staged === true\n` +
		`2. Read any preserved scalars (result.count, result.total, etc.)\n` +
		`3. Return the staging metadata — the caller will use ${prefix}_query_data with the data_access_id to explore the data with SQL\n\n` +
		`DO NOT try to access .results, .data, .entries, .items on a staged response — those arrays were replaced by SQLite tables.\n\n` +
		`For advanced use: api.query(data_access_id, sql) and db.queryStaged(data_access_id, sql) are available to query staged data ` +
		`within the same execution (returns {results, row_count}, max 1000 rows, SELECT only).\n\n` +
		`SCRATCHPAD: db.stage(data, tableName?) stages any array/object into SQLite and returns {data_access_id, tables_created, total_rows}. ` +
		`Use this to persist computed or filtered results for SQL queries.\n\n` +
		`IMPORTANT: Use pagination params (first/after, limit/offset) to keep responses small. If you need large datasets, let them auto-stage and return the staging info.` +
		(preamble ? `\n\nSERVER NOTES:\n${extractPreambleNotes(preamble)}` : "")
	);
}
