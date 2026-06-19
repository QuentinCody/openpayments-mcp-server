import { describe, expect, it, vi } from "vitest";
import {
	buildPrefixHeader,
	COMMON_PREFIXES,
	probeSparqlEndpoint,
	type SparqlFetchFn,
} from "./sparql-introspection";

const binding = (variable: string, values: Array<string | number | undefined>) => ({
	results: {
		bindings: values.map((v) => ({ [variable]: v === undefined ? {} : { value: v } })),
	},
});

// Route each probe query to a canned result by its distinctive text.
const routedFetch = (
	over: Partial<Record<"graphs" | "predicates" | "classes", unknown | (() => never)>> = {},
): SparqlFetchFn =>
	vi.fn(async (query: string) => {
		const pick = query.includes("void:sparqlEndpoint")
			? over.graphs ?? binding("g", ["urn:graph1"])
			: query.includes("?s a ?type")
				? over.classes ?? binding("type", ["urn:ClassA"])
				: over.predicates ?? binding("p", ["urn:p1", "urn:p2"]);
		if (typeof pick === "function") (pick as () => never)();
		return pick;
	});

describe("probeSparqlEndpoint", () => {
	it("collects graphs, predicates, and classes from VOID + probe queries", async () => {
		const result = await probeSparqlEndpoint("https://sparql.test", routedFetch());
		expect(result).toEqual({
			endpointUrl: "https://sparql.test",
			graphs: ["urn:graph1"],
			predicates: ["urn:p1", "urn:p2"],
			classes: ["urn:ClassA"],
			warnings: [],
		});
	});

	it("records a warning per failing probe and leaves that section empty", async () => {
		const boom = () => {
			throw new Error("endpoint down");
		};
		const result = await probeSparqlEndpoint(
			"https://sparql.test",
			routedFetch({ graphs: boom, predicates: boom, classes: boom }),
		);
		expect(result.graphs).toEqual([]);
		expect(result.predicates).toEqual([]);
		expect(result.classes).toEqual([]);
		expect(result.warnings).toHaveLength(3);
		expect(result.warnings[0]).toContain("VOID graph discovery failed: endpoint down");
		expect(result.warnings[1]).toContain("Predicate probe failed");
		expect(result.warnings[2]).toContain("Class probe failed");
	});

	it("skips bindings whose value is missing or non-string", async () => {
		const result = await probeSparqlEndpoint(
			"https://sparql.test",
			routedFetch({ predicates: binding("p", ["urn:keep", undefined, 42]) }),
		);
		expect(result.predicates).toEqual(["urn:keep"]);
	});

	it("tolerates a malformed (binding-less) response", async () => {
		const result = await probeSparqlEndpoint("https://sparql.test", routedFetch({ graphs: {} }));
		expect(result.graphs).toEqual([]);
	});
});

describe("buildPrefixHeader", () => {
	it("renders PREFIX declarations, one per line", () => {
		expect(buildPrefixHeader({ rdf: "http://r#", owl: "http://o#" })).toBe(
			"PREFIX rdf: <http://r#>\nPREFIX owl: <http://o#>",
		);
	});

	it("works over the shipped COMMON_PREFIXES", () => {
		const header = buildPrefixHeader(COMMON_PREFIXES);
		expect(header).toContain("PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>");
		expect(header.split("\n")).toHaveLength(Object.keys(COMMON_PREFIXES).length);
	});
});
