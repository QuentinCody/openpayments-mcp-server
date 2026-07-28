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
import type { ApiCatalog, ApiEndpoint } from "./catalog";
import {
	countByCategory,
	formatEndpoint,
	searchEndpoints,
	type SearchToolResult,
} from "./search-core";

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

	const categoryCounts = countByCategory(catalog);
	const categoryList = categoryCounts
		.map(({ category, count }) => `${category} (${count})`)
		.join(", ");

	const notesSection = catalog.notes ? `\n\nNOTES:\n${catalog.notes}` : "";

	return {
		name: toolName,
		description:
			`Search the ${catalog.name} API catalog (${catalog.endpointCount} endpoints). ` +
			`Returns matching endpoints with full parameter docs. Use this to discover API capabilities before calling ${prefix}_execute.\n\n` +
			`Categories: ${categoryList}\n\n` +
			`USAGE IN ${prefix}_execute:\n` +
			`- api.get(path, params) for GET, api.post(path, body, params) for POST\n` +
			`- Path params like /lookup/{id} are auto-interpolated from params: api.get('/lookup/{id}', {id: 'ENSG...'})\n` +
			`- Remaining params become query string\n` +
			`- Large responses (>100KB) are auto-staged: check result.__staged, return the staging info, use ${prefix}_query_data to explore\n` +
			`- Use limit/pagination params to control response size. Large datasets auto-stage for SQL queries.` +
			notesSection,
		schema: {
			query: z
				.string()
				.describe(
					"Search query — keywords matching endpoint paths, descriptions, parameters, or categories. Examples: 'gene expression', 'variant annotation', 'tissue'",
				),
			category: z
				.string()
				.optional()
				.describe(
					"Filter to a specific category. Use query='*' with a category to list all endpoints in that category.",
				),
			max_results: z
				.number()
				.optional()
				.describe("Maximum results to return (default 10, max 25)"),
		},

		register(server: { tool: (...args: unknown[]) => void }) {
			server.tool(
				toolName,
				this.description,
				this.schema,
				async (input: {
					query: string;
					category?: string;
					max_results?: number;
				}) => {
					const maxResults = Math.min(input.max_results || 10, 25);
					const query = input.query?.trim() || "";

					let endpoints = catalog.endpoints;

					// Filter by category if specified
					if (input.category) {
						endpoints = endpoints.filter(
							(ep) => ep.category.toLowerCase() === input.category?.toLowerCase(),
						);
					}

					let results: ApiEndpoint[];

					if (query === "*" || query === "") {
						// List mode — return all (within category filter)
						results = endpoints.slice(0, maxResults);
					} else {
						results = searchEndpoints(endpoints, query, maxResults);
					}

					if (results.length === 0) {
						const catList = categoryCounts
							.map(({ category, count }) => `  ${category} (${count} endpoints)`)
							.join("\n");

						// A zero-result search is a SUCCESSFUL search that matched nothing,
						// and it still must carry structuredContent. This is the single most
						// common exploration outcome; without it the caller gets no
						// machine-readable signal at all — no result count, no category
						// hints — only prose it would have to parse back out.
						return {
							content: [
								{
									type: "text" as const,
									text: `No endpoints found for "${query}"${input.category ? ` in category "${input.category}"` : ""}.\n\nAvailable categories:\n${catList}\n\nTry broader search terms or browse by category.`,
								},
							],
							structuredContent: {
								success: true,
								data: {
									total_endpoints: catalog.endpointCount,
									results_count: 0,
									endpoints: [],
									query,
									category: input.category ?? null,
									available_categories: categoryCounts,
								},
							},
						};
					}

					const formatted = results.map(formatEndpoint).join("\n\n");
					const header = `Found ${results.length} endpoint(s) in ${catalog.name} API (${catalog.endpointCount} total):`;

					return {
						content: [
							{ type: "text" as const, text: `${header}\n\n${formatted}` },
						],
						structuredContent: {
							success: true,
							data: {
								total_endpoints: catalog.endpointCount,
								results_count: results.length,
								endpoints: results,
							},
						},
					};
				},
			);
		},
	};
}
