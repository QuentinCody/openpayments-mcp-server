// Tool-level GraphQL schema search (#3).
//
// The ~11 GraphQL servers shipped with only `<prefix>_execute` (+ in-isolate
// schema.* helpers) and NO `<prefix>_search` tool — so a model would guess field
// names and get invalid-query / empty (chars=0) results, the single biggest
// GraphQL failure source. This surfaces the SAME trimmed introspection the
// execute tool already caches as a discovery tool: token-search the query roots +
// types/fields so the model copies REAL names before writing a query. Scoring
// mirrors the in-isolate schema.search() (type name 3 / type desc 1 / field name
// 2 / field desc 1); query-root hits are surfaced first since those are the
// top-level entry points a query starts from.

import type {
	TrimmedField,
	TrimmedIntrospection,
} from "./graphql-introspection";

/** `name(arg: Type, …)` — empty when the field takes no args. */
function formatArgs(field: TrimmedField): string {
	if (!field.args || field.args.length === 0) return "";
	return `(${field.args.map((a) => `${a.name}: ${a.type}`).join(", ")})`;
}

function formatField(typeName: string, field: TrimmedField): string {
	const desc = field.description ? ` — ${field.description.split("\n")[0].slice(0, 120)}` : "";
	return `${typeName}.${field.name}${formatArgs(field)}: ${field.type}${desc}`;
}

/** The query-root fields (top-level entry points) of the schema. */
function queryRootFields(intro: TrimmedIntrospection): TrimmedField[] {
	const qt = intro.types.find((t) => t.name === intro.queryType?.name);
	return qt?.fields ?? [];
}

/** Browse mode (empty query): list the query roots so the model sees the entry points. */
function renderQueryRoots(intro: TrimmedIntrospection, max: number): string {
	const roots = queryRootFields(intro).slice(0, max);
	if (roots.length === 0) return "No query-root fields found in the schema.";
	const lines = roots.map((f) => `  • ${f.name}${formatArgs(f)}: ${f.type}`);
	return (
		`Query roots (top-level entry points) — call one of these inside a gql.query('{ … }'):\n` +
		lines.join("\n") +
		`\n\nSearch with a keyword (e.g. a gene, disease, or entity) to narrow, and call schema.type("<ReturnType>") inside _execute to see a return type's fields.`
	);
}

interface FieldHit {
	typeName: string;
	field: TrimmedField;
	isQueryRoot: boolean;
	score: number;
}

/**
 * Token-search the trimmed introspection and format the matches for the model.
 * Query-root matches are listed first (they're where a query starts); other
 * matching `Type.field` signatures follow, then a short how-to. Pure + testable;
 * the `<prefix>_search` tool is a thin wrapper that feeds it the cached schema.
 */
export function searchTrimmedIntrospection(
	intro: TrimmedIntrospection,
	query: string,
	maxResults = 12,
): string {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return renderQueryRoots(intro, maxResults);

	const queryTypeName = intro.queryType?.name;
	const fieldHits: FieldHit[] = [];
	const typeMatches: string[] = [];

	for (const t of intro.types) {
		if (t.name.startsWith("__")) continue; // introspection meta-types
		const typeName = t.name.toLowerCase();
		const typeDesc = (t.description || "").toLowerCase();
		let typeScore = 0;
		for (const tok of tokens) {
			if (typeName.includes(tok)) typeScore += 3;
			if (typeDesc.includes(tok)) typeScore += 1;
		}
		if (typeScore > 0) typeMatches.push(t.name);

		for (const f of t.fields ?? []) {
			const fieldName = f.name.toLowerCase();
			const fieldDesc = (f.description || "").toLowerCase();
			let fieldScore = 0;
			for (const tok of tokens) {
				if (fieldName.includes(tok)) fieldScore += 2;
				if (fieldDesc.includes(tok)) fieldScore += 1;
			}
			if (fieldScore > 0) {
				fieldHits.push({
					typeName: t.name,
					field: f,
					isQueryRoot: t.name === queryTypeName,
					score: fieldScore,
				});
			}
		}
	}

	// Query roots first (entry points), then by score.
	fieldHits.sort(
		(a, b) =>
			Number(b.isQueryRoot) - Number(a.isQueryRoot) || b.score - a.score,
	);

	if (fieldHits.length === 0 && typeMatches.length === 0) {
		return (
			`No schema matches for "${query}". Browse the entry points with an empty query, ` +
			`or open _execute and call schema.queryRoot() / schema.search("${tokens[0]}") to explore.`
		);
	}

	const roots = fieldHits.filter((h) => h.isQueryRoot).slice(0, maxResults);
	const others = fieldHits.filter((h) => !h.isQueryRoot).slice(0, maxResults);
	const out: string[] = [`${fieldHits.length} schema match(es) for "${query}":`];

	if (roots.length > 0) {
		out.push(
			"\nQuery roots (top-level entry points):\n" +
				roots.map((h) => `  • ${h.field.name}${formatArgs(h.field)}: ${h.field.type}` +
					(h.field.description ? ` — ${h.field.description.split("\n")[0].slice(0, 120)}` : "")).join("\n"),
		);
	}
	if (others.length > 0) {
		out.push(
			"\nMatching fields:\n" +
				others.map((h) => `  • ${formatField(h.typeName, h.field)}`).join("\n"),
		);
	}
	if (typeMatches.length > 0) {
		out.push(`\nMatching types: ${typeMatches.slice(0, 20).join(", ")}`);
	}
	out.push(
		`\nNext: write the query in _execute, e.g. gql.query('{ <queryRoot>(<args>) { <fields> } }'). ` +
			`Call schema.type("<ReturnType>") in your code to list a return type's full fields.`,
	);
	return out.join("\n");
}
