/**
 * GraphQL introspection-to-summary — generates a compact API reference
 * for embedding in the `_execute` tool description.
 *
 * The output lists top-level query fields with their arguments and key
 * types with their important fields, giving the LLM enough context to
 * start writing queries immediately.
 */

import type { TrimmedIntrospection, TrimmedField, TrimmedType } from "./graphql-introspection";

// ── Options ──────────────────────────────────────────────────────────────

export interface IntrospectionSummaryOptions {
	/** Max number of query root fields to show (default 15) */
	maxQueryFields?: number;
	/** Max key types to show in detail (default 8) */
	maxTypes?: number;
	/** Max fields per type (default 8) */
	maxFieldsPerType?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatArgs(field: TrimmedField): string {
	if (!field.args || field.args.length === 0) return "";
	const parts = field.args.map((a) => {
		const req = a.type.endsWith("!") ? "" : "?";
		return `${a.name}${req}: ${a.type.replace(/!$/, "")}`;
	});
	return `(${parts.join(", ")})`;
}

function formatReturnType(field: TrimmedField): string {
	// Strip outer non-null/list wrappers for readability
	return field.type.replace(/!$/, "");
}

/**
 * Score a type for relevance. Higher = more likely to be shown.
 * Prefers types that are return types of query root fields.
 */
function scoreType(
	type: TrimmedType,
	referencedTypes: Set<string>,
): number {
	let score = 0;
	if (referencedTypes.has(type.name)) score += 10;
	if (type.fields) score += Math.min(type.fields.length, 10);
	if (type.kind === "OBJECT") score += 2;
	if (type.kind === "ENUM") score += 1;
	return score;
}

/**
 * Extract the base type name from a flattened type string.
 * "[Gene!]!" → "Gene", "TargetResult" → "TargetResult"
 */
function baseTypeName(typeStr: string): string {
	return typeStr.replace(/[[\]!]/g, "");
}

// ── Main generator ───────────────────────────────────────────────────────

/**
 * Generate a compact GraphQL schema summary from trimmed introspection data.
 */
export function introspectionToSummary(
	introspection: TrimmedIntrospection,
	options?: IntrospectionSummaryOptions,
): string {
	const maxQueryFields = options?.maxQueryFields ?? 15;
	const maxTypes = options?.maxTypes ?? 8;
	const maxFieldsPerType = options?.maxFieldsPerType ?? 8;

	const typeMap = new Map<string, TrimmedType>();
	for (const t of introspection.types) {
		typeMap.set(t.name, t);
	}

	// Find query root type
	const queryType = typeMap.get(introspection.queryType.name);
	if (!queryType?.fields || queryType.fields.length === 0) return "";

	const lines: string[] = [];

	// --- Query fields ---
	const queryFields = queryType.fields.slice(0, maxQueryFields);
	const totalQueryFields = queryType.fields.length;

	lines.push(`GRAPHQL SCHEMA (${totalQueryFields} query fields):`);
	lines.push("  Query fields:");

	// Collect referenced types from query root
	const referencedTypes = new Set<string>();
	for (const f of queryType.fields) {
		referencedTypes.add(baseTypeName(f.type));
	}

	for (const f of queryFields) {
		const args = formatArgs(f);
		const ret = formatReturnType(f);
		const desc = f.description ? ` -- ${f.description}` : "";
		lines.push(`    ${f.name}${args} -> ${ret}${desc}`);
	}

	if (totalQueryFields > maxQueryFields) {
		lines.push(`    ... ${totalQueryFields - maxQueryFields} more -- use schema.queryRoot() to see all`);
	}

	// --- Key types ---
	const objectTypes = introspection.types.filter(
		(t) => t.kind === "OBJECT" && t.name !== introspection.queryType.name
			&& t.name !== introspection.mutationType?.name
			&& t.fields && t.fields.length > 0,
	);

	const rankedTypes = objectTypes
		.map((t) => ({ type: t, score: scoreType(t, referencedTypes) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, maxTypes);

	if (rankedTypes.length > 0) {
		lines.push("  Key types:");
		for (const { type } of rankedTypes) {
			const allFields = type.fields ?? [];
			const fields = allFields.slice(0, maxFieldsPerType);
			const fieldNames = fields.map((f) => f.name);
			const omitted = allFields.length - fields.length;
			const suffix = omitted > 0 ? `, ... +${omitted} more` : "";
			lines.push(`    ${type.name}: ${fieldNames.join(", ")}${suffix}`);
		}

		const totalObjects = objectTypes.length;
		if (totalObjects > maxTypes) {
			lines.push(`  ... ${totalObjects - maxTypes} more types -- use schema.type(name) or schema.search(query) in your code`);
		}
	}

	return lines.join("\n");
}
