/**
 * Search tool factory — creates a `<prefix>_search` tool for API discovery.
 *
 * Two modes:
 * 1. **Catalog mode** (legacy) — runs in-process keyword search over a static ApiCatalog.
 * 2. **OpenAPI mode** (new) — evaluates agent-written JS with the full resolved
 *    OpenAPI spec available. The agent can search paths, list tags, describe
 *    operations, etc., using injected helper functions.
 *
 * When `openApiSpec` is provided, the tool switches to OpenAPI mode.
 * When only `catalog` is provided, the tool uses the original catalog mode.
 */

import { z } from "zod";
import type { ApiCatalog, ApiEndpoint } from "./catalog";
import type { ResolvedSpec } from "./openapi-resolver";
import { executeSearchCode } from "./safe-expression";

interface OpenApiOperation {
	path: string;
	method: string;
	summary?: string;
	description?: string;
	operationId?: string;
	tags?: string[];
	parameters?: Array<{
		name?: string;
		in?: string;
		required?: boolean;
		description?: string;
		schema?: { type?: string };
		type?: string;
	}>;
	requestBody?: {
		description?: string;
		content?: Record<string, unknown>;
	};
	responses?: Record<string, { description?: string }>;
}

export interface SearchToolOptions {
	/** Tool name prefix (e.g., "gtex" → "gtex_search") */
	prefix: string;
	/** The API catalog to search (legacy mode) */
	catalog?: ApiCatalog;
	/** Resolved OpenAPI spec for code-execution search (new mode) */
	openApiSpec?: ResolvedSpec;
}

export interface SearchToolResult {
	name: string;
	description: string;
	schema: Record<string, z.ZodType>;
	register: (server: { tool: (...args: unknown[]) => void }) => void;
}

/**
 * Token-based search over catalog endpoints.
 */
function searchEndpoints(
	endpoints: ApiEndpoint[],
	query: string,
	maxResults: number,
): ApiEndpoint[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [];

	const scored = endpoints.map((ep) => {
		const text = [
			ep.path,
			ep.summary,
			ep.description || "",
			ep.category,
			ep.method,
			...(ep.pathParams || []).map((p) => `${p.name} ${p.description}`),
			...(ep.queryParams || []).map((p) => `${p.name} ${p.description}`),
		]
			.join(" ")
			.toLowerCase();

		let score = 0;
		for (const token of tokens) {
			if (text.includes(token)) score++;
		}
		return { endpoint: ep, score };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map((s) => s.endpoint);
}

/**
 * Format an endpoint for display.
 */
function formatEndpoint(ep: ApiEndpoint): string {
	const lines = [`${ep.method} ${ep.path} — ${ep.summary}`];
	if (ep.coveredByTool) lines.push(`  (also available via tool: ${ep.coveredByTool})`);

	if (ep.pathParams?.length) {
		for (const p of ep.pathParams) {
			lines.push(`  Path: {${p.name}} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}`);
		}
	}

	if (ep.queryParams?.length) {
		for (const p of ep.queryParams) {
			const extras: string[] = [];
			if (p.default !== undefined) extras.push(`default: ${JSON.stringify(p.default)}`);
			if (p.enum) extras.push(`values: ${JSON.stringify(p.enum)}`);
			lines.push(`  Query: ${p.name} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}${extras.length ? ` [${extras.join(", ")}]` : ""}`);
		}
	}

	if (ep.body) {
		lines.push(`  Body: ${ep.body.contentType}${ep.body.description ? ` — ${ep.body.description}` : ""}`);
	}

	if (ep.usageHint) {
		lines.push(`  Profile: ${ep.usageHint}`);
	}

	return lines.join("\n");
}

/**
 * Count the total number of operations in a resolved OpenAPI spec.
 */
function countSpecOperations(spec: ResolvedSpec): number {
	const methods = ["get", "post", "put", "delete", "patch", "options", "head", "trace"];
	let count = 0;
	for (const pathItem of Object.values(spec.paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		for (const method of methods) {
			if ((pathItem as Record<string, unknown>)[method]) count++;
		}
	}
	return count;
}

function formatOperation(op: OpenApiOperation): string {
	const lines = [`${op.method.toUpperCase()} ${op.path} — ${op.summary || op.operationId || "No summary"}`];

	if (op.operationId) lines.push(`  Operation ID: ${op.operationId}`);
	if (op.tags?.length) lines.push(`  Tags: ${op.tags.join(", ")}`);

	for (const param of op.parameters || []) {
		const type = param.schema?.type || param.type || "unknown";
		const location = param.in || "unknown";
		lines.push(
			`  Param: ${param.name || "(unnamed)"} (${location}, ${type}, ${param.required ? "required" : "optional"})` +
			`${param.description ? ` — ${param.description}` : ""}`,
		);
	}

	const contentTypes = Object.keys(op.requestBody?.content || {});
	if (contentTypes.length > 0) {
		lines.push(
			`  Body: ${contentTypes[0]}${op.requestBody?.description ? ` — ${op.requestBody.description}` : ""}`,
		);
	}

	if (op.responses) {
		for (const [status, response] of Object.entries(op.responses)) {
			if (response?.description) {
				lines.push(`  Response: ${status} — ${response.description}`);
				break;
			}
		}
	}

	return lines.join("\n");
}

/**
 * Build OpenAPI helper functions directly as closures over the parsed spec.
 * Avoids `new Function()` which is blocked by the workerd runtime.
 */
export function createOpenApiHelpers(specJson: string) {
	const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "options", "head", "trace"];
	let spec: ResolvedSpec;
	try {
		spec = Object.freeze(JSON.parse(specJson)) as ResolvedSpec;
	} catch (e) {
		throw new Error(`Failed to parse OpenAPI spec JSON for search tool: ${e instanceof Error ? e.message : e}`);
	}

	function collectOperations(): OpenApiOperation[] {
		const ops: OpenApiOperation[] = [];
		const paths = spec.paths || {};
		for (const [pathStr, pathItem] of Object.entries(paths)) {
			if (!pathItem || typeof pathItem !== "object") continue;
			for (const method of HTTP_METHODS) {
				const op = (pathItem as Record<string, unknown>)[method] as Record<string, unknown> | undefined;
				if (!op || typeof op !== "object") continue;
				ops.push({ path: pathStr, method, ...op } as OpenApiOperation);
			}
		}
		return ops;
	}

	function searchPaths(query: string, maxResults = 10): OpenApiOperation[] {
		const ops = collectOperations();
		if (!query || query.trim() === "") return ops.slice(0, maxResults);

		const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
		if (tokens.length === 0) return ops.slice(0, maxResults);

		const scored: Array<{ op: OpenApiOperation; score: number }> = [];
		for (const op of ops) {
			const textParts = [
				op.path || "", op.method || "", op.summary || "",
				op.description || "", op.operationId || "",
				(op.tags || []).join(" "),
			];
			if (Array.isArray(op.parameters)) {
				for (const param of op.parameters) {
					if (param.name) textParts.push(param.name);
					if (param.description) textParts.push(param.description);
				}
			}
			const text = textParts.join(" ").toLowerCase();
			let score = 0;
			for (const token of tokens) {
				if (text.includes(token)) score++;
			}
			if (score > 0) scored.push({ op, score });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, maxResults).map((s) => s.op);
	}

	function listTags(): Array<{ tag: string; count: number }> {
		const ops = collectOperations();
		const tagCounts: Record<string, number> = {};
		for (const op of ops) {
			if (!Array.isArray(op.tags)) continue;
			for (const tag of op.tags) {
				tagCounts[tag] = (tagCounts[tag] || 0) + 1;
			}
		}
		return Object.entries(tagCounts).map(([tag, count]) => ({ tag, count }));
	}

	function getOperation(idOrPath: string): OpenApiOperation | null {
		const ops = collectOperations();
		for (const op of ops) {
			if (op.operationId === idOrPath) return op;
		}
		for (const op of ops) {
			if (op.path === idOrPath) return op;
		}
		return null;
	}

	function getOperationByPathAndMethod(path: string, method?: string): OpenApiOperation | null {
		const ops = collectOperations();
		const normalizedMethod = method ? method.toLowerCase() : null;
		for (const op of ops) {
			if (op.path !== path) continue;
			if (!normalizedMethod || op.method === normalizedMethod) return op;
		}
		return null;
	}

	function describeOp(op: OpenApiOperation | null, missingLabel: string): string {
		if (!op) return missingLabel;
		const lines = [`${op.method.toUpperCase()} ${op.path}`];
		if (op.operationId) lines.push(`Operation ID: ${op.operationId}`);
		if (op.summary) lines.push(`Summary: ${op.summary}`);
		if (op.description) lines.push(`Description: ${op.description}`);
		if (op.tags?.length) lines.push(`Tags: ${op.tags.join(", ")}`);
		if (Array.isArray(op.parameters) && op.parameters.length > 0) {
			lines.push("Parameters:");
			for (const p of op.parameters) {
				const paramType = p.schema?.type || p.type || "unknown";
				let line = `  ${p.name || "(unnamed)"} (${p.in || "unknown"}, ${paramType}${p.required ? ", required" : ""})`;
				if (p.description) line += ` — ${p.description}`;
				lines.push(line);
			}
		}
		if (op.responses) {
			const respEntries = Object.entries(op.responses);
			if (respEntries.length > 0) {
				lines.push("Responses:");
				for (const [code, resp] of respEntries) {
					lines.push(`  ${code}: ${resp?.description || ""}`);
				}
			}
		}
		return lines.join("\n");
	}

	function describeOperation(idOrPath: string): string {
		return describeOp(getOperation(idOrPath), `Operation not found: ${idOrPath}`);
	}

	function describeEndpoint(path: string, method?: string): string {
		const op = getOperationByPathAndMethod(path, method);
		const label = `Endpoint not found: ${(method || "GET").toUpperCase()} ${path}`;
		return describeOp(op, label);
	}

	return {
		searchPaths,
		listTags,
		getOperation,
		describeOperation,
		searchSpec: searchPaths,
		listCategories: () => listTags().map((e) => ({ category: e.tag, count: e.count })),
		getEndpoint: getOperationByPathAndMethod,
		describeEndpoint,
		spec,
		SPEC: spec,
	};
}

/**
 * Create a search tool in OpenAPI mode.
 *
 * The tool accepts a `code` parameter — agent-written JavaScript that runs
 * with the full resolved OpenAPI spec and helper functions (searchPaths,
 * listTags, getOperation, describeOperation) available.
 */
function createOpenApiSearchTool(prefix: string, spec: ResolvedSpec): SearchToolResult {
	const toolName = `${prefix}_search`;
	const operationCount = countSpecOperations(spec);
	const specJson = JSON.stringify(spec);
	const helpers = createOpenApiHelpers(specJson);

	return {
		name: toolName,
		description:
			`Search the ${spec.info.title} API (${operationCount} operations across ${Object.keys(spec.paths).length} paths). ` +
			`Write JavaScript code to search the OpenAPI spec, or use the legacy query/category arguments for keyword search. Available functions:\n\n` +
			`- searchPaths(query, maxResults=10) — keyword search across paths, summaries, tags, parameters\n` +
			`- listTags() — list all tags with operation counts\n` +
			`- getOperation(idOrPath) — get full operation by operationId or path\n` +
			`- describeOperation(idOrPath) — formatted documentation for an operation\n` +
			`- searchSpec/query helpers are also available for backward compatibility inside execute()\n` +
			`- spec — the full frozen OpenAPI spec object (spec.paths, spec.info, etc.)\n\n` +
			`Use ${prefix}_search to discover endpoints, then write code in ${prefix}_execute to call them.\n\n` +
			`USAGE IN ${prefix}_execute:\n` +
			`- api.get(path, params) for GET, api.post(path, body, params) for POST\n` +
			`- Path params like /lookup/{id} are auto-interpolated from params\n` +
			`- Large responses (>100KB) are auto-staged; use ${prefix}_query_data to explore`,
		schema: {
			code: z.string().describe(
				"JavaScript code to search the API spec. Use searchPaths(), listTags(), " +
				"getOperation(), describeOperation(), or access spec.paths directly. " +
				'Examples: \'return searchPaths("studies")\', \'return listTags()\', ' +
				'\'return describeOperation("getStudies")\'',
			),
			query: z.string().optional().describe(
				"Legacy keyword search. Optional alternative to code. Use '*' or an empty string to browse operations.",
			),
			category: z.string().optional().describe(
				"Legacy category filter. Matches OpenAPI tags case-insensitively.",
			),
			max_results: z.number().optional().describe(
				"Maximum results to return for legacy keyword search (default 10, max 25).",
			),
		},

		register(server: { tool: (...args: unknown[]) => void }) {
			const description = this.description;
			const schema = this.schema;

			server.tool(toolName, description, schema, async (input: {
				code?: string;
				query?: string;
				category?: string;
				max_results?: number;
			}) => {
				const code = input.code?.trim() || "";
				const query = input.query?.trim() || "";
				const category = input.category?.trim();
					const maxResults = Math.min(input.max_results || 10, 25);

					if (!code) {
						let results = query === "*" || query === ""
						? helpers.searchPaths("", operationCount)
						: helpers.searchPaths(query, category ? operationCount : maxResults);

					if (category) {
						const normalized = category.toLowerCase();
						results = results.filter((op) =>
							(op.tags || []).some((tag) => tag.toLowerCase() === normalized)
						);
					}

					if (query === "*" || query === "") {
						results = results.slice(0, maxResults);
					}

					if (results.length === 0) {
						const availableTags = helpers.listTags()
							.map((entry) => `  ${entry.tag} (${entry.count} operations)`)
							.join("\n");
						return {
							content: [{
								type: "text" as const,
								text:
									`No operations found for "${query || "*"}"${category ? ` in category "${category}"` : ""}.\n\n` +
									`Available categories:\n${availableTags}\n\nTry broader search terms, browse by category, or provide code.`,
							}],
							structuredContent: {
								success: true,
								data: {
									total_operations: operationCount,
									total_endpoints: operationCount,
									results_count: 0,
									operations: [],
									endpoints: [],
								},
							},
						};
					}

					const formatted = results.map(formatOperation).join("\n\n");
					const header = `Found ${results.length} operation(s) in ${spec.info.title} API (${operationCount} total):`;

					return {
						content: [{ type: "text" as const, text: `${header}\n\n${formatted}` }],
						structuredContent: {
							success: true,
							data: {
								total_operations: operationCount,
								total_endpoints: operationCount,
								results_count: results.length,
								operations: results,
								endpoints: results,
							},
						},
					};
				}

				try {
					// Try safe interpreter first, fall back to new Function()
					// for complex JS (map/filter chains, Object.entries, etc.).
					const result = executeSearchCode(code, helpers);

					let textOutput: string;
					if (typeof result === "string") {
						textOutput = result;
					} else {
						textOutput = JSON.stringify(result, null, 2) ?? String(result);
					}

					return {
						content: [{ type: "text" as const, text: textOutput }],
						structuredContent: {
							success: true,
							data: result,
						},
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{
							type: "text" as const,
							text: `Search code error: ${message}`,
						}],
						structuredContent: {
							success: false,
							error: { code: "SEARCH_ERROR", message },
						},
						isError: true,
					};
				}
			});
		},
	};
}

/**
 * Create a search tool in catalog mode (legacy).
 *
 * The tool accepts query/category/max_results parameters and performs
 * keyword-based search over the static ApiCatalog.
 */
function createCatalogSearchTool(prefix: string, catalog: ApiCatalog): SearchToolResult {
	const toolName = `${prefix}_search`;

	// Collect categories for the description
	const categories = new Map<string, number>();
	for (const ep of catalog.endpoints) {
		categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
	}
	const categoryList = Array.from(categories.entries())
		.map(([cat, count]) => `${cat} (${count})`)
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
			query: z.string().describe(
				"Search query — keywords matching endpoint paths, descriptions, parameters, or categories. Examples: 'gene expression', 'variant annotation', 'tissue'",
			),
			category: z.string().optional().describe(
				"Filter to a specific category. Use query='*' with a category to list all endpoints in that category.",
			),
			max_results: z.number().optional().describe(
				"Maximum results to return (default 10, max 25)",
			),
		},

		register(server: { tool: (...args: unknown[]) => void }) {
			server.tool(
				toolName,
				this.description,
				this.schema,
				async (input: { query: string; category?: string; max_results?: number }) => {
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
						// Return available categories as a hint
						const categories = new Map<string, number>();
						for (const ep of catalog.endpoints) {
							categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
						}
						const catList = Array.from(categories.entries())
							.map(([cat, count]) => `  ${cat} (${count} endpoints)`)
							.join("\n");

						return {
							content: [{
								type: "text" as const,
								text: `No endpoints found for "${query}"${input.category ? ` in category "${input.category}"` : ""}.\n\nAvailable categories:\n${catList}\n\nTry broader search terms or browse by category.`,
							}],
						};
					}

					const formatted = results.map(formatEndpoint).join("\n\n");
					const header = `Found ${results.length} endpoint(s) in ${catalog.name} API (${catalog.endpointCount} total):`;

					return {
						content: [{ type: "text" as const, text: `${header}\n\n${formatted}` }],
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

/**
 * Create a search tool registration object.
 * Returns { name, description, schema, register } for the server to use.
 *
 * When `openApiSpec` is provided, creates a code-execution search tool.
 * When only `catalog` is provided, creates a keyword search tool (legacy).
 */
export function createSearchTool(options: SearchToolOptions): SearchToolResult {
	const { prefix, catalog, openApiSpec } = options;

	if (openApiSpec) {
		return createOpenApiSearchTool(prefix, openApiSpec);
	}

	if (catalog) {
		return createCatalogSearchTool(prefix, catalog);
	}

	throw new Error("createSearchTool requires either 'catalog' or 'openApiSpec'");
}
