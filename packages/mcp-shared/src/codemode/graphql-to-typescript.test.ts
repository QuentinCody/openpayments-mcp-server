import { describe, it, expect } from "vitest";
import { introspectionToSummary } from "./graphql-to-typescript";
import type { TrimmedIntrospection } from "./graphql-introspection";

const MOCK_INTROSPECTION: TrimmedIntrospection = {
	queryType: { name: "Query" },
	types: [
		{
			name: "Query",
			kind: "OBJECT",
			fields: [
				{
					name: "target",
					type: "Target",
					args: [{ name: "q", type: "TargetInput!" }],
					description: "Look up a target",
				},
				{
					name: "targets",
					type: "[Target!]!",
					args: [
						{ name: "filter", type: "IFilter" },
						{ name: "top", type: "Int" },
						{ name: "skip", type: "Int" },
					],
					description: "List targets",
				},
				{
					name: "disease",
					type: "Disease",
					args: [{ name: "name", type: "String!" }],
				},
			],
		},
		{
			name: "Target",
			kind: "OBJECT",
			fields: [
				{ name: "name", type: "String" },
				{ name: "tdl", type: "String" },
				{ name: "fam", type: "String" },
				{ name: "description", type: "String" },
				{ name: "sym", type: "String" },
			],
		},
		{
			name: "Disease",
			kind: "OBJECT",
			fields: [
				{ name: "name", type: "String!" },
				{ name: "description", type: "String" },
			],
		},
		{
			name: "Ligand",
			kind: "OBJECT",
			fields: [
				{ name: "name", type: "String" },
				{ name: "smiles", type: "String" },
			],
		},
	],
};

describe("introspectionToSummary", () => {
	it("generates a summary with query fields", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION);
		expect(summary).toContain("GRAPHQL SCHEMA (3 query fields):");
		expect(summary).toContain("target(q: TargetInput) -> Target");
		expect(summary).toContain("disease(name: String) -> Disease");
	});

	it("includes key types section", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION);
		expect(summary).toContain("Key types:");
		expect(summary).toContain("Target: name, tdl, fam, description, sym");
	});

	it("shows description for query fields", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION);
		expect(summary).toContain("-- Look up a target");
	});

	it("respects maxQueryFields", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION, { maxQueryFields: 1 });
		expect(summary).toContain("target(");
		expect(summary).toContain("... 2 more");
		expect(summary).not.toContain("disease(");
	});

	it("respects maxTypes", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION, { maxTypes: 1 });
		expect(summary).toContain("Target:");
		expect(summary).toContain("more types");
	});

	it("respects maxFieldsPerType", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION, { maxFieldsPerType: 2 });
		expect(summary).toMatch(/Target: name, tdl, \.\.\. \+3 more/);
	});

	it("marks optional args with ?", () => {
		const summary = introspectionToSummary(MOCK_INTROSPECTION);
		// filter is optional (type "IFilter" without !)
		expect(summary).toContain("filter?: IFilter");
		// top is optional
		expect(summary).toContain("top?: Int");
	});

	it("returns empty string for empty query root", () => {
		const empty: TrimmedIntrospection = {
			queryType: { name: "Query" },
			types: [{ name: "Query", kind: "OBJECT", fields: [] }],
		};
		expect(introspectionToSummary(empty)).toBe("");
	});

	it("returns empty string when query type is missing", () => {
		const missing: TrimmedIntrospection = {
			queryType: { name: "Query" },
			types: [],
		};
		expect(introspectionToSummary(missing)).toBe("");
	});
});
