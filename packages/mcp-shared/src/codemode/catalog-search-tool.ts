/**
 * Catalog-mode `<prefix>_search` tool — keyword search over a static ApiCatalog.
 *
 * Extracted from search-tool.ts, which hosts both search modes (static catalog
 * here, OpenAPI-spec-driven there) and had outgrown the file-size cap.
 *
 * `createSearchTool` in search-tool.ts remains the entry point; it dispatches
 * here when only a `catalog` is supplied.
 */

import { z } from "zod";
import type { ApiCatalog } from "./catalog";
import { type CatalogSearchInput, catalogDiscoveryResponse, discoveryCategories } from "./catalog-discovery";
import type { SearchToolResult } from "./search-core";

/**
 * Create a search tool in catalog mode (legacy).
 *
 * The tool accepts query/category/max_results parameters and performs
 * keyword-based search over the static ApiCatalog.
 */
export function createCatalogSearchTool(
	prefix: string,
	catalog: ApiCatalog,
): SearchToolResult {
	const toolName = `${prefix}_search`;

	const categoryCounts = discoveryCategories(catalog);
	const categoryList = categoryCounts
		.map(({ category, count }) => `${category} (${count})`)
		.join(", ");

	const notesSection = catalog.notes ? `\n\nNOTES:\n${catalog.notes}` : "";

	return {
		name: toolName,
		description:
			`Search the ${catalog.name} API catalog (${catalog.endpoints.length} endpoints). ` +
			`Returns matching endpoints and intact executable workflow recipes. Search never executes recipe code. Use this before calling ${prefix}_execute.\n\n` +
			`Categories: ${categoryList}\n\n` +
			`USAGE IN ${prefix}_execute:\n` +
			`- api.get(path, params) for GET, api.post(path, body, params) for POST\n` +
			`- Path params like /lookup/{id} are auto-interpolated from params: api.get('/lookup/{id}', {id: 'ENSG...'})\n` +
			`- Remaining params become query string\n` +
			`- Discovery reports truncated/omitted counts for undisplayed matches. Browse recipes with query='*', category='workflows'.\n` +
			`- Large API collections (>30KB) are auto-staged: check result.__staged, return the staging info, use ${prefix}_query_data to explore\n` +
			`- Use limit/pagination params to control response size. Large datasets auto-stage for SQL queries.` +
			notesSection,
		schema: {
			query: z
				.string()
				.describe(
					"Search endpoint paths/descriptions/parameters and workflow titles/descriptions/keywords. Examples: 'gene expression', 'variant annotation', 'tissue'",
				),
			category: z
				.string()
				.optional()
				.describe(
					"Filter endpoint category; use category='workflows' for recipes. Omit category to search both. Use query='*' to browse within the result limit.",
				),
			max_results: z
				.number()
				.optional()
				.describe("Maximum results of each kind (default 10, clamped to 1–25); inline byte budget may reduce this further"),
		},

		register(server: { tool: (...args: unknown[]) => void }) {
			server.tool(
				toolName,
				this.description,
				this.schema,
				async (input: CatalogSearchInput) => catalogDiscoveryResponse(catalog, input),
			);
		},
	};
}
