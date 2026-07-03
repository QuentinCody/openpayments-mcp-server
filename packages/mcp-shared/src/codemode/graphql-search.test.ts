import { describe, expect, it } from "vitest";
import type { TrimmedIntrospection } from "./graphql-introspection";
import { searchTrimmedIntrospection } from "./graphql-search";

// An Open Targets-shaped trimmed introspection fixture.
const INTRO: TrimmedIntrospection = {
	queryType: { name: "Query" },
	types: [
		{
			name: "Query",
			kind: "OBJECT",
			fields: [
				{ name: "disease", type: "Disease", args: [{ name: "efoId", type: "String!" }], description: "Look up a disease by EFO id" },
				{ name: "search", type: "SearchResults", args: [{ name: "queryString", type: "String!" }], description: "Free-text search across entities" },
				{ name: "target", type: "Target", args: [{ name: "ensemblId", type: "String!" }], description: "Look up a target by Ensembl id" },
			],
		},
		{
			name: "Disease",
			kind: "OBJECT",
			description: "A disease or phenotype",
			fields: [
				{ name: "id", type: "String!" },
				{ name: "name", type: "String!" },
				{ name: "associatedTargets", type: "AssociatedTargets", args: [{ name: "page", type: "Pagination" }], description: "Targets associated with this disease" },
			],
		},
		{ name: "__Type", kind: "OBJECT", fields: [{ name: "name", type: "String" }] },
	],
};

describe("searchTrimmedIntrospection", () => {
	it("lists query roots in browse mode (empty query)", () => {
		const out = searchTrimmedIntrospection(INTRO, "");
		expect(out).toContain("Query roots");
		expect(out).toContain("disease(efoId: String!): Disease");
		expect(out).toContain("search(queryString: String!): SearchResults");
	});

	it("surfaces query-root matches first, with args and return types", () => {
		const out = searchTrimmedIntrospection(INTRO, "disease");
		expect(out).toContain("Query roots (top-level entry points)");
		expect(out).toContain("disease(efoId: String!): Disease");
		// The Disease.associatedTargets field also matches and appears under fields.
		expect(out).toContain("Disease.associatedTargets(page: Pagination): AssociatedTargets");
		expect(out).toContain("Matching types: Disease");
	});

	it("finds a nested field by its own name", () => {
		const out = searchTrimmedIntrospection(INTRO, "associated");
		expect(out).toContain("Disease.associatedTargets");
	});

	it("skips introspection meta-types (__Type)", () => {
		const out = searchTrimmedIntrospection(INTRO, "name");
		expect(out).not.toContain("__Type");
	});

	it("returns a helpful message on no match", () => {
		const out = searchTrimmedIntrospection(INTRO, "zzzznomatch");
		expect(out).toContain("No schema matches");
		expect(out).toContain("schema.queryRoot()");
	});
});
