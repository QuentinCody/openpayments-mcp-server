import { describe, expect, it } from "vitest";
import { graphQlToCatalog } from "./graphql-catalog";

// Minimal GraphQL type-ref builders matching introspection JSON.
const STRING = { kind: "SCALAR", name: "String" };
const INT = { kind: "SCALAR", name: "Int" };
const BOOLEAN = { kind: "SCALAR", name: "Boolean" };
const nonNull = (ofType: unknown) => ({ kind: "NON_NULL", ofType });
const list = (ofType: unknown) => ({ kind: "LIST", ofType });
const obj = (name: string) => ({ kind: "OBJECT", name });

const OPTS = { name: "TestQL", baseUrl: "https://gql.test" };

const introspection = {
	__schema: {
		queryType: { name: "Query" },
		mutationType: { name: "Mutation" },
		types: [
			{
				name: "Query",
				fields: [
					{ name: "__typename", args: [], type: STRING }, // introspection field — skipped
					{
						name: "gene",
						description: "Look up a gene",
						args: [
							{
								name: "symbol",
								description: "HGNC symbol",
								type: nonNull(STRING),
							},
							{ name: "limit", type: INT, defaultValue: "10" },
							{ name: "ids", type: list(nonNull(STRING)) },
						],
						type: nonNull(list(nonNull(obj("Gene")))),
					},
					{ name: "ping", args: [], type: BOOLEAN, isDeprecated: true },
				],
			},
			{
				name: "Mutation",
				fields: [
					{
						name: "saveGene",
						description: "persist",
						args: [],
						type: obj("Gene"),
					},
				],
			},
		],
	},
};

describe("graphQlToCatalog", () => {
	const { catalog, diagnostics } = graphQlToCatalog(introspection, OPTS);
	const byName = (summaryPrefix: string) =>
		catalog.endpoints.find((e) => e.summary.startsWith(summaryPrefix));

	it("maps queries to POST /graphql endpoints with arg-derived queryParams", () => {
		const gene = byName("Query: gene");
		expect(gene).toMatchObject({
			method: "POST",
			path: "/graphql",
			category: "queries",
		});
		expect(gene?.queryParams).toEqual([
			{
				name: "symbol",
				type: "string",
				required: true,
				description: "HGNC symbol",
			},
			{
				name: "limit",
				type: "number",
				required: false,
				description: "limit",
				default: "10",
			},
			{ name: "ids", type: "array", required: false, description: "ids" },
		]);
	});

	it("unwraps NON_NULL/LIST wrappers into the response shape", () => {
		expect(byName("Query: gene")?.responseShape).toBe("Array<Gene>");
		expect(byName("Mutation: saveGene")?.responseShape).toBe("Gene");
	});

	it("builds a usage hint that inlines required args only", () => {
		expect(byName("Query: gene")?.usageHint).toContain(
			"{ gene(symbol: $symbol) { ... } }",
		);
		expect(byName("Query: ping")?.usageHint).toContain("{ ping { ... } }");
	});

	it("skips __ introspection fields, flags deprecation, and maps mutations", () => {
		expect(
			catalog.endpoints.some((e) => e.summary.includes("__typename")),
		).toBe(false);
		expect(byName("Query: ping")?.deprecated).toBe(true);
		expect(byName("Mutation: saveGene")?.category).toBe("mutations");
		expect(catalog.endpointCount).toBe(3);
		expect(diagnostics).toEqual([]);
	});

	it("defaults the GraphQL usage notes and honors an override", () => {
		expect(catalog.notes).toContain("GraphQL API.");
		const custom = graphQlToCatalog(introspection, {
			...OPTS,
			notes: "custom",
		});
		expect(custom.catalog.notes).toBe("custom");
	});

	it("accepts introspection nested under data.__schema", () => {
		const nested = graphQlToCatalog({ data: introspection }, OPTS);
		expect(nested.catalog.endpointCount).toBe(3);
	});

	it("errors when __schema or types are missing", () => {
		const noSchema = graphQlToCatalog({}, OPTS);
		expect(noSchema.catalog.endpointCount).toBe(0);
		expect(noSchema.diagnostics[0]).toMatchObject({ level: "error" });

		const noTypes = graphQlToCatalog({ __schema: {} }, OPTS);
		expect(noTypes.diagnostics[0].message).toContain("No types");
	});

	it("warns when the schema has no queries or mutations", () => {
		const empty = graphQlToCatalog({ __schema: { types: [] } }, OPTS);
		expect(empty.catalog.endpointCount).toBe(0);
		expect(empty.diagnostics[0]).toMatchObject({ level: "warn" });
	});
});
