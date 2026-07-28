/**
 * Shared core for the `<prefix>_search` tool factories.
 *
 * Holds the pieces both search modes need — the result/options types, keyword
 * scoring, and endpoint formatting — so `search-tool.ts` (OpenAPI mode, and the
 * dispatcher) and `catalog-search-tool.ts` (static-catalog mode) can each import
 * them without importing each other. Keeping this module leaf-level is what makes
 * the module graph acyclic.
 */

import type { z } from "zod";
import type { ApiCatalog, ApiEndpoint } from "./catalog";
import type { ResolvedSpec } from "./openapi-resolver";

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
export function searchEndpoints(
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
export function formatEndpoint(ep: ApiEndpoint): string {
	const lines = [`${ep.method} ${ep.path} — ${ep.summary}`];
	if (ep.coveredByTool)
		lines.push(`  (also available via tool: ${ep.coveredByTool})`);

	if (ep.pathParams?.length) {
		for (const p of ep.pathParams) {
			lines.push(
				`  Path: {${p.name}} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}`,
			);
		}
	}

	if (ep.queryParams?.length) {
		for (const p of ep.queryParams) {
			const extras: string[] = [];
			if (p.default !== undefined)
				extras.push(`default: ${JSON.stringify(p.default)}`);
			if (p.enum) extras.push(`values: ${JSON.stringify(p.enum)}`);
			lines.push(
				`  Query: ${p.name} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}${extras.length ? ` [${extras.join(", ")}]` : ""}`,
			);
		}
	}

	if (ep.body) {
		lines.push(
			`  Body: ${ep.body.contentType}${ep.body.description ? ` — ${ep.body.description}` : ""}`,
		);
	}

	if (ep.usageHint) {
		lines.push(`  Profile: ${ep.usageHint}`);
	}

	return lines.join("\n");
}

/** Category name → number of endpoints in it. */
export function countByCategory(
	catalog: ApiCatalog,
): Array<{ category: string; count: number }> {
	const categories = new Map<string, number>();
	for (const ep of catalog.endpoints) {
		categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
	}
	return Array.from(categories.entries()).map(([category, count]) => ({
		category,
		count,
	}));
}
