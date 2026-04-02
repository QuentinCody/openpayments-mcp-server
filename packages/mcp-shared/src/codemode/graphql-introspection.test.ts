import { describe, it, expect, beforeAll } from "vitest";
import {
	flattenTypeRef,
	trimIntrospectionResult,
	fetchIntrospection,
	type GraphqlFetchFn,
	type TrimmedIntrospection,
} from "./graphql-introspection";

// ---------------------------------------------------------------------------
// flattenTypeRef
// ---------------------------------------------------------------------------

describe("flattenTypeRef", () => {
	it("returns scalar name", () => {
		expect(flattenTypeRef({ kind: "SCALAR", name: "String" })).toBe("String");
	});

	it("returns NON_NULL scalar", () => {
		expect(
			flattenTypeRef({
				kind: "NON_NULL",
				ofType: { kind: "SCALAR", name: "Int" },
			}),
		).toBe("Int!");
	});

	it("returns LIST of scalars", () => {
		expect(
			flattenTypeRef({
				kind: "LIST",
				ofType: { kind: "SCALAR", name: "String" },
			}),
		).toBe("[String]");
	});

	it("returns NON_NULL LIST of NON_NULL objects", () => {
		expect(
			flattenTypeRef({
				kind: "NON_NULL",
				ofType: {
					kind: "LIST",
					ofType: {
						kind: "NON_NULL",
						ofType: { kind: "OBJECT", name: "Gene" },
					},
				},
			}),
		).toBe("[Gene!]!");
	});

	it("returns OBJECT name", () => {
		expect(flattenTypeRef({ kind: "OBJECT", name: "Target" })).toBe("Target");
	});

	it("handles null/undefined", () => {
		expect(flattenTypeRef(null)).toBe("Unknown");
		expect(flattenTypeRef(undefined)).toBe("Unknown");
	});

	it("handles missing name", () => {
		expect(flattenTypeRef({ kind: "SCALAR" })).toBe("SCALAR");
	});
});

// ---------------------------------------------------------------------------
// trimIntrospectionResult
// ---------------------------------------------------------------------------

const MOCK_RAW_INTROSPECTION = {
	__schema: {
		queryType: { name: "Query" },
		mutationType: null,
		types: [
			{
				name: "Query",
				kind: "OBJECT",
				description: "Root query type",
				fields: [
					{
						name: "gene",
						description: "Look up a gene by symbol",
						type: { kind: "OBJECT", name: "Gene" },
						args: [
							{
								name: "symbol",
								type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } },
								defaultValue: null,
								description: "Gene symbol",
							},
						],
					},
				],
				inputFields: null,
				enumValues: null,
				possibleTypes: null,
			},
			{
				name: "Gene",
				kind: "OBJECT",
				description: "A gene with associated variants and evidence",
				fields: [
					{
						name: "id",
						description: null,
						type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "Int" } },
						args: [],
					},
					{
						name: "name",
						description: null,
						type: { kind: "SCALAR", name: "String" },
						args: [],
					},
				],
				inputFields: null,
				enumValues: null,
				possibleTypes: null,
			},
			// Built-in scalar — should be stripped
			{
				name: "String",
				kind: "SCALAR",
				description: "Built-in string",
				fields: null,
				inputFields: null,
				enumValues: null,
				possibleTypes: null,
			},
			// Introspection type — should be stripped
			{
				name: "__Schema",
				kind: "OBJECT",
				description: "Introspection schema type",
				fields: [{ name: "types", type: { kind: "LIST", ofType: { kind: "OBJECT", name: "__Type" } }, args: [] }],
				inputFields: null,
				enumValues: null,
				possibleTypes: null,
			},
			// Enum type
			{
				name: "EvidenceLevel",
				kind: "ENUM",
				description: null,
				fields: null,
				inputFields: null,
				enumValues: [
					{ name: "A", description: "Validated" },
					{ name: "B", description: "Clinical" },
				],
				possibleTypes: null,
			},
			// Custom scalar — should be kept
			{
				name: "DateTime",
				kind: "SCALAR",
				description: "ISO 8601 date-time",
				fields: null,
				inputFields: null,
				enumValues: null,
				possibleTypes: null,
			},
		],
	},
};

describe("trimIntrospectionResult", () => {
	let result: TrimmedIntrospection;

	beforeAll(() => {
		result = trimIntrospectionResult(MOCK_RAW_INTROSPECTION);
	});

	it("preserves queryType", () => {
		expect(result.queryType).toEqual({ name: "Query" });
	});

	it("strips null mutationType", () => {
		expect(result.mutationType).toBeUndefined();
	});

	it("strips built-in scalars", () => {
		const names = result.types.map((t) => t.name);
		expect(names).not.toContain("String");
		expect(names).not.toContain("Int");
		expect(names).not.toContain("Boolean");
	});

	it("strips introspection types", () => {
		const names = result.types.map((t) => t.name);
		expect(names).not.toContain("__Schema");
	});

	it("keeps custom scalars", () => {
		const names = result.types.map((t) => t.name);
		expect(names).toContain("DateTime");
	});

	it("keeps object types with fields", () => {
		const query = result.types.find((t) => t.name === "Query");
		expect(query).toBeDefined();
		expect(query?.fields).toHaveLength(1);
		expect(query?.fields?.[0].name).toBe("gene");
	});

	it("flattens field types", () => {
		const gene = result.types.find((t) => t.name === "Gene");
		expect(gene?.fields?.[0].type).toBe("Int!");
		expect(gene?.fields?.[1].type).toBe("String");
	});

	it("flattens arg types", () => {
		const query = result.types.find((t) => t.name === "Query");
		const geneField = query?.fields?.[0];
		expect(geneField?.args?.[0].type).toBe("String!");
	});

	it("keeps enum values", () => {
		const ev = result.types.find((t) => t.name === "EvidenceLevel");
		expect(ev?.kind).toBe("ENUM");
		expect(ev?.enumValues).toHaveLength(2);
		expect(ev?.enumValues?.[0].name).toBe("A");
	});

	it("truncates long descriptions", () => {
		const longDesc = "A".repeat(200);
		const raw = {
			__schema: {
				queryType: { name: "Query" },
				mutationType: null,
				types: [
					{
						name: "LongDesc",
						kind: "OBJECT",
						description: longDesc,
						fields: [],
						inputFields: null,
						enumValues: null,
						possibleTypes: null,
					},
				],
			},
		};
		const trimmed = trimIntrospectionResult(raw);
		const t = trimmed.types.find((x) => x.name === "LongDesc");
		expect(t?.description?.length).toBeLessThanOrEqual(100);
		expect(t?.description).toMatch(/\.\.\.$/);
	});
});

// ---------------------------------------------------------------------------
// fetchIntrospection
// ---------------------------------------------------------------------------

describe("fetchIntrospection", () => {
	it("fetches and trims introspection", async () => {
		const mockFetch: GraphqlFetchFn = async () => ({
			data: MOCK_RAW_INTROSPECTION,
		});

		const result = await fetchIntrospection(mockFetch);
		expect(result.queryType.name).toBe("Query");
		expect(result.types.length).toBeGreaterThan(0);
	});

	it("throws on introspection errors", async () => {
		const mockFetch: GraphqlFetchFn = async () => ({
			errors: [{ message: "Not authorized" }],
		});

		await expect(fetchIntrospection(mockFetch)).rejects.toThrow("Introspection query failed");
	});

	it("throws on missing __schema", async () => {
		const mockFetch: GraphqlFetchFn = async () => ({
			data: { something: "else" },
		});

		await expect(fetchIntrospection(mockFetch)).rejects.toThrow("missing __schema");
	});
});
