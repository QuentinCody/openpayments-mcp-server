import { describe, it, expect } from "vitest";
import { buildGraphqlSchemaSource } from "./graphql-schema-source";
import type { TrimmedIntrospection } from "./graphql-introspection";

const MOCK_INTROSPECTION: TrimmedIntrospection = {
	queryType: { name: "Query" },
	mutationType: { name: "Mutation" },
	types: [
		{
			name: "Query",
			kind: "OBJECT",
			fields: [
				{
					name: "gene",
					type: "Gene",
					args: [{ name: "symbol", type: "String!" }],
					description: "Look up a gene",
				},
				{
					name: "variants",
					type: "[Variant!]!",
					args: [{ name: "geneId", type: "Int!" }],
				},
			],
		},
		{
			name: "Mutation",
			kind: "OBJECT",
			fields: [
				{ name: "addGene", type: "Gene", args: [{ name: "name", type: "String!" }] },
			],
		},
		{
			name: "Gene",
			kind: "OBJECT",
			description: "A gene entity",
			fields: [
				{ name: "id", type: "Int!" },
				{ name: "name", type: "String" },
				{ name: "entrezId", type: "Int" },
			],
		},
		{
			name: "Variant",
			kind: "OBJECT",
			fields: [
				{ name: "id", type: "Int!" },
				{ name: "name", type: "String" },
			],
		},
		{
			name: "EvidenceLevel",
			kind: "ENUM",
			enumValues: [
				{ name: "A", description: "Validated" },
				{ name: "B", description: "Clinical" },
			],
		},
		{
			name: "GeneInput",
			kind: "INPUT_OBJECT",
			inputFields: [
				{ name: "symbol", type: "String!" },
				{ name: "entrezId", type: "Int" },
			],
		},
	],
};

/**
 * Evaluate the generated source in a minimal sandbox and return the `schema` object.
 */
function evalSchemaSource(introspection: TrimmedIntrospection): Record<string, (...args: unknown[]) => unknown> {
	const source = buildGraphqlSchemaSource(JSON.stringify(introspection));
	// The source declares `var SCHEMA`, `var __typeMap`, `var schema`
	const fn = new Function(`${source}\nreturn schema;`);
	return fn();
}

describe("buildGraphqlSchemaSource", () => {
	it("returns a string containing SCHEMA declaration", () => {
		const source = buildGraphqlSchemaSource(JSON.stringify(MOCK_INTROSPECTION));
		expect(source).toContain("var SCHEMA = Object.freeze");
		expect(source).toContain("var schema = {");
	});
});

describe("schema.types()", () => {
	it("lists all types", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const types = schema.types() as Array<{ name: string; kind: string }>;
		const names = types.map((t) => t.name);
		expect(names).toContain("Gene");
		expect(names).toContain("Variant");
		expect(names).toContain("EvidenceLevel");
	});

	it("filters by kind", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const enums = schema.types("ENUM") as Array<{ name: string; kind: string }>;
		expect(enums).toHaveLength(1);
		expect(enums[0].name).toBe("EvidenceLevel");
	});
});

describe("schema.type()", () => {
	it("returns type by name", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const gene = schema.type("Gene") as { name: string; fields: Array<{ name: string }> };
		expect(gene.name).toBe("Gene");
		expect(gene.fields).toHaveLength(3);
	});

	it("returns null for unknown type", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		expect(schema.type("NonExistent")).toBeNull();
	});
});

describe("schema.search()", () => {
	it("finds types by name", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const results = schema.search("gene") as Array<{ type: string; field: string | null; score: number }>;
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].type).toBe("Gene");
	});

	it("finds fields across types", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const results = schema.search("entrez") as Array<{ type: string; field: string | null }>;
		const fieldMatch = results.find((r) => r.field === "entrezId");
		expect(fieldMatch).toBeDefined();
		expect(fieldMatch?.type).toBe("Gene");
	});

	it("respects maxResults", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const results = schema.search("a", 2) as unknown[];
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it("returns empty for blank query", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		expect(schema.search("")).toEqual([]);
	});
});

describe("schema.queryRoot()", () => {
	it("returns query root fields", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const roots = schema.queryRoot() as Array<{ name: string; args: unknown[]; returnType: string }>;
		expect(roots).toHaveLength(2);
		expect(roots[0].name).toBe("gene");
		expect(roots[0].returnType).toBe("Gene");
		expect(roots[0].args).toHaveLength(1);
	});
});

describe("schema.mutationRoot()", () => {
	it("returns mutation root fields", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const mutations = schema.mutationRoot() as Array<{ name: string }>;
		expect(mutations).toHaveLength(1);
		expect(mutations[0].name).toBe("addGene");
	});

	it("returns empty when no mutation type", () => {
		const noMutation: TrimmedIntrospection = {
			queryType: { name: "Query" },
			types: [{ name: "Query", kind: "OBJECT", fields: [] }],
		};
		const schema = evalSchemaSource(noMutation);
		expect(schema.mutationRoot()).toEqual([]);
	});
});

describe("schema.inputType()", () => {
	it("returns input fields", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const fields = schema.inputType("GeneInput") as Array<{ name: string; type: string }>;
		expect(fields).toHaveLength(2);
		expect(fields[0].name).toBe("symbol");
	});

	it("returns null for non-input type", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		expect(schema.inputType("Gene")).toBeNull();
	});
});

describe("schema.enumValues()", () => {
	it("returns enum values", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		const values = schema.enumValues("EvidenceLevel") as Array<{ name: string; description?: string }>;
		expect(values).toHaveLength(2);
		expect(values[0].name).toBe("A");
		expect(values[0].description).toBe("Validated");
	});

	it("returns null for non-enum type", () => {
		const schema = evalSchemaSource(MOCK_INTROSPECTION);
		expect(schema.enumValues("Gene")).toBeNull();
	});
});
