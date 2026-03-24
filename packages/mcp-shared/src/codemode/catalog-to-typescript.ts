/**
 * Catalog-to-TypeScript summary — generates a compact API reference for
 * embedding in the `_execute` tool description.
 *
 * The output uses HTTP method + path format so it maps directly to
 * `api.get(path, params)` calls. It is NOT runnable TypeScript — it's a
 * concise, LLM-friendly reference that replaces the need for a `_search`
 * round-trip for common operations.
 *
 * The catalog remains the single source of truth. This function is a pure
 * formatter — call it at server boot time to generate the summary string.
 */

import type { ApiCatalog, ApiEndpoint, ParamDef } from "./catalog";
import type { ResolvedSpec } from "./openapi-resolver";

// ── Options ──────────────────────────────────────────────────────────────

export interface CatalogSummaryOptions {
	/**
	 * Approximate max number of endpoints to include in the summary.
	 * Default 20 — roughly 600-800 tokens depending on param verbosity.
	 */
	maxEndpoints?: number;
}

// ── Param formatting ─────────────────────────────────────────────────────

function formatParam(p: ParamDef): string {
	const suffix = p.required ? "" : "?";
	if (p.enum && p.enum.length > 0 && p.enum.length <= 5) {
		const values = p.enum.map((v) => JSON.stringify(v)).join("|");
		return `${p.name}${suffix}: ${values}`;
	}
	return `${p.name}${suffix}`;
}

function formatParamList(endpoint: ApiEndpoint): string {
	const parts: string[] = [];
	const required: string[] = [];
	const optional: string[] = [];

	for (const p of endpoint.pathParams || []) {
		(p.required ? required : optional).push(formatParam(p));
	}
	for (const p of endpoint.queryParams || []) {
		(p.required ? required : optional).push(formatParam(p));
	}

	if (required.length > 0) parts.push(required.join(", "));
	if (optional.length > 0) parts.push(optional.join(", "));

	if (parts.length === 0 && endpoint.body) {
		parts.push("body: JSON");
	}

	return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

// ── Endpoint selection ───────────────────────────────────────────────────

/**
 * Score an endpoint for heuristic selection when `featured` is not set.
 * Higher score = more likely to be included.
 */
function endpointScore(ep: ApiEndpoint): number {
	let score = 0;
	// Endpoints with more params tend to be more important/specific
	score += (ep.pathParams?.length || 0) * 2;
	score += (ep.queryParams?.length || 0);
	// GET is the most common operation
	if (ep.method === "GET") score += 1;
	// Covered-by-tool means it's important enough to have a dedicated tool
	if (ep.coveredByTool) score += 3;
	// Prefer endpoints with descriptions
	if (ep.description) score += 1;
	return score;
}

/**
 * Select endpoints for the summary, respecting featured flags and budget.
 */
function selectEndpoints(
	endpoints: ApiEndpoint[],
	maxEndpoints: number,
): ApiEndpoint[] {
	// Filter out deprecated
	const active = endpoints.filter((ep) => !ep.deprecated);

	// If we're under budget, include all active endpoints
	if (active.length <= maxEndpoints) return active;

	const selected: ApiEndpoint[] = [];
	const selectedPaths = new Set<string>();

	function add(ep: ApiEndpoint): boolean {
		const key = `${ep.method} ${ep.path}`;
		if (selectedPaths.has(key)) return false;
		selectedPaths.add(key);
		selected.push(ep);
		return true;
	}

	// Phase 1: All featured endpoints
	for (const ep of active) {
		if (ep.featured) add(ep);
	}

	if (selected.length >= maxEndpoints) {
		return selected.slice(0, maxEndpoints);
	}

	// Phase 2: Best endpoint per category (not yet selected)
	const categories = new Map<string, ApiEndpoint[]>();
	for (const ep of active) {
		const key = `${ep.method} ${ep.path}`;
		if (selectedPaths.has(key)) continue;
		const list = categories.get(ep.category) || [];
		list.push(ep);
		categories.set(ep.category, list);
	}

	// Sort each category's endpoints by score, pick top one
	for (const [, eps] of categories) {
		if (selected.length >= maxEndpoints) break;
		eps.sort((a, b) => endpointScore(b) - endpointScore(a));
		add(eps[0]);
	}

	if (selected.length >= maxEndpoints) {
		return selected.slice(0, maxEndpoints);
	}

	// Phase 3: Fill remaining budget with highest-scored unused endpoints
	const remaining = active
		.filter((ep) => !selectedPaths.has(`${ep.method} ${ep.path}`))
		.sort((a, b) => endpointScore(b) - endpointScore(a));

	for (const ep of remaining) {
		if (selected.length >= maxEndpoints) break;
		add(ep);
	}

	return selected;
}

// ── Main generators ──────────────────────────────────────────────────────

/**
 * Generate a compact API summary from an ApiCatalog.
 *
 * The catalog remains the single source of truth — this is a pure formatter.
 * The output is designed for embedding in an MCP tool description.
 */
export function catalogToTypeScript(
	catalog: ApiCatalog,
	options?: CatalogSummaryOptions,
): string {
	const maxEndpoints = options?.maxEndpoints ?? 20;
	const selected = selectEndpoints(catalog.endpoints, maxEndpoints);

	if (selected.length === 0) return "";

	// Group by category, preserving the order endpoints appear in the catalog
	const groups = new Map<string, ApiEndpoint[]>();
	for (const ep of selected) {
		const list = groups.get(ep.category) || [];
		list.push(ep);
		groups.set(ep.category, list);
	}

	const lines: string[] = [];

	lines.push(`API REFERENCE (${catalog.name}, ${selected.length} of ${catalog.endpointCount} endpoints):`);

	for (const [category, eps] of groups) {
		lines.push(`  ${category}:`);
		for (const ep of eps) {
			const params = formatParamList(ep);
			lines.push(`    ${ep.method} ${ep.path} — ${ep.summary}${params}`);
		}
	}

	const omitted = catalog.endpointCount - selected.length;
	if (omitted > 0) {
		lines.push(`  ... ${omitted} more endpoints — use searchSpec(query) in your code to discover them`);
	}

	return lines.join("\n");
}

// ── OpenAPI spec summary ─────────────────────────────────────────────────

interface SpecParam {
	name?: string;
	in?: string;
	required?: boolean;
	schema?: { type?: string; enum?: unknown[] };
	type?: string;
	enum?: unknown[];
}

interface SpecOperation {
	summary?: string;
	operationId?: string;
	description?: string;
	tags?: string[];
	parameters?: SpecParam[];
	requestBody?: { content?: Record<string, unknown> };
}

/**
 * Generate a compact API summary from a resolved OpenAPI spec.
 */
export function specToTypeScript(
	spec: ResolvedSpec,
	options?: CatalogSummaryOptions,
): string {
	const maxEndpoints = options?.maxEndpoints ?? 20;
	const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

	// Collect all operations
	interface OpEntry {
		method: string;
		path: string;
		summary: string;
		tag: string;
		params: string;
		score: number;
	}

	const ops: OpEntry[] = [];
	for (const [path, pathItem] of Object.entries(spec.paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		const pathParams: SpecParam[] = Array.isArray((pathItem as Record<string, unknown>).parameters)
			? (pathItem as Record<string, unknown>).parameters as SpecParam[]
			: [];

		for (const method of HTTP_METHODS) {
			const op = (pathItem as Record<string, unknown>)[method] as SpecOperation | undefined;
			if (!op || typeof op !== "object") continue;

			const allParams = [...pathParams, ...(op.parameters || [])];
			const required: string[] = [];
			const optional: string[] = [];

			for (const p of allParams) {
				if (!p.name) continue;
				const suffix = p.required ? "" : "?";
				const enumValues = p.schema?.enum || p.enum;
				if (enumValues && Array.isArray(enumValues) && enumValues.length <= 5) {
					const values = enumValues.map((v) => JSON.stringify(v)).join("|");
					(p.required ? required : optional).push(`${p.name}${suffix}: ${values}`);
				} else {
					(p.required ? required : optional).push(`${p.name}${suffix}`);
				}
			}

			const parts: string[] = [];
			if (required.length > 0) parts.push(required.join(", "));
			if (optional.length > 0) parts.push(optional.join(", "));
			if (parts.length === 0 && op.requestBody) parts.push("body: JSON");

			const paramStr = parts.length > 0 ? ` (${parts.join("; ")})` : "";
			const summary = op.summary || op.operationId || op.description?.slice(0, 60) || "";
			const tag = op.tags?.[0] || "general";

			ops.push({
				method: method.toUpperCase(),
				path,
				summary,
				tag,
				params: paramStr,
				score: allParams.length + (method === "get" ? 1 : 0),
			});
		}
	}

	if (ops.length === 0) return "";

	// Select operations: one per tag first, then fill by score
	const selected: OpEntry[] = [];
	const selectedKeys = new Set<string>();

	if (ops.length <= maxEndpoints) {
		selected.push(...ops);
	} else {
		// One per tag
		const tagBest = new Map<string, OpEntry>();
		for (const op of ops) {
			const current = tagBest.get(op.tag);
			if (!current || op.score > current.score) {
				tagBest.set(op.tag, op);
			}
		}
		for (const op of tagBest.values()) {
			if (selected.length >= maxEndpoints) break;
			const key = `${op.method} ${op.path}`;
			if (!selectedKeys.has(key)) {
				selectedKeys.add(key);
				selected.push(op);
			}
		}

		// Fill remaining by score
		const remaining = ops
			.filter((op) => !selectedKeys.has(`${op.method} ${op.path}`))
			.sort((a, b) => b.score - a.score);

		for (const op of remaining) {
			if (selected.length >= maxEndpoints) break;
			const key = `${op.method} ${op.path}`;
			if (!selectedKeys.has(key)) {
				selectedKeys.add(key);
				selected.push(op);
			}
		}
	}

	// Group by tag
	const groups = new Map<string, OpEntry[]>();
	for (const op of selected) {
		const list = groups.get(op.tag) || [];
		list.push(op);
		groups.set(op.tag, list);
	}

	const title = spec.info?.title || "API";
	const lines: string[] = [];
	lines.push(`API REFERENCE (${title}, ${selected.length} of ${ops.length} operations):`);

	for (const [tag, tagOps] of groups) {
		lines.push(`  ${tag}:`);
		for (const op of tagOps) {
			lines.push(`    ${op.method} ${op.path} — ${op.summary}${op.params}`);
		}
	}

	const omitted = ops.length - selected.length;
	if (omitted > 0) {
		lines.push(`  ... ${omitted} more operations — use searchSpec(query) or searchPaths(query) in your code to discover them`);
	}

	return lines.join("\n");
}
