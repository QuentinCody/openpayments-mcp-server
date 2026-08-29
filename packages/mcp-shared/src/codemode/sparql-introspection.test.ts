import { describe, expect, it, vi } from "vitest";
import {
	buildPrefixHeader,
	COMMON_PREFIXES,
	probeSparqlEndpoint,
	type SparqlFetchFn,
} from "./sparql-introspection";

const binding = (
	variable: string,
	values: Array<string | number | undefined>,
) => ({
	results: {
		bindings: values.map((v) => ({
			[variable]: v === undefined ? {} : { value: v },
		})),
	},
});

// Route each probe query to a canned result by its distinctive text.
const routedFetch = (
	over: Partial<
		Record<"graphs" | "predicates" | "classes", unknown | (() => never)>
	> = {},
): SparqlFetchFn =>
	vi.fn(async (query: string) => {
		const pick = query.includes("void:sparqlEndpoint")
			? (over.graphs ?? binding("g", ["urn:graph1"]))
			: query.includes("?s a ?type")
				? (over.classes ?? binding("type", ["urn:ClassA"]))
				: (over.predicates ?? binding("p", ["urn:p1", "urn:p2"]));
		if (typeof pick === "function") (pick as () => never)();
		return pick;
	});

describe("probeSparqlEndpoint", () => {
	it("collects graphs, predicates, and classes from VOID + probe queries", async () => {
		const result = await probeSparqlEndpoint(
			"https://sparql.test",
			routedFetch(),
		);
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
		// Four, not three: when the exhaustive predicate scan fails, the sampled
		// fallback is attempted too and reports its own failure. Assert WHICH
		// warnings are present rather than a bare count, so adding a probe does
		// not silently satisfy this test.
		const joined = result.warnings.join("\n");
		expect(joined).toContain("VOID graph discovery failed: endpoint down");
		expect(joined).toContain("Predicate probe failed");
		expect(joined).toContain("Class probe failed");
		expect(joined).toContain("Sampled predicate probe failed");
		expect(result.warnings).toHaveLength(4);
	});

	it("skips bindings whose value is missing or non-string", async () => {
		const result = await probeSparqlEndpoint(
			"https://sparql.test",
			routedFetch({ predicates: binding("p", ["urn:keep", undefined, 42]) }),
		);
		expect(result.predicates).toEqual(["urn:keep"]);
	});

	it("tolerates a malformed (binding-less) response", async () => {
		const result = await probeSparqlEndpoint(
			"https://sparql.test",
			routedFetch({ graphs: {} }),
		);
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
		expect(header).toContain(
			"PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
		);
		expect(header.split("\n")).toHaveLength(
			Object.keys(COMMON_PREFIXES).length,
		);
	});
});

/**
 * Discovery must never dominate the isolate budget it was meant to serve.
 *
 * bgee's canonical sweep probe measured 29-30s wall clock while the Bgee SPARQL
 * endpoint answered the actual user query in 0.36s. The whole gap was
 * `SELECT DISTINCT ?p WHERE { ?s ?p ?o } LIMIT 30` — 28.98s, because DISTINCT
 * must scan the entire store before it can honour the LIMIT. The sweep was
 * passing with roughly 160ms of headroom against a 30s ceiling.
 */
describe("probeSparqlEndpoint budget", () => {
	const bindings = (variable: string, ...values: string[]) => ({
		results: { bindings: values.map((v) => ({ [variable]: { value: v } })) },
	});

	it("passes a per-probe timeout to every probe", async () => {
		const seen: (number | undefined)[] = [];
		const fetchFn = async (_q: string, opts?: { timeoutMs?: number }) => {
			seen.push(opts?.timeoutMs);
			return bindings("p", "http://example.org/p1");
		};
		await probeSparqlEndpoint("https://e.test/sparql", fetchFn, { perProbeTimeoutMs: 1234 });
		expect(seen).toHaveLength(3);
		expect(seen.every((t) => t === 1234)).toBe(true);
	});

	it("defaults the per-probe budget rather than letting a probe run unbounded", async () => {
		const seen: (number | undefined)[] = [];
		const fetchFn = async (_q: string, opts?: { timeoutMs?: number }) => {
			seen.push(opts?.timeoutMs);
			return bindings("p");
		};
		await probeSparqlEndpoint("https://e.test/sparql", fetchFn);
		expect(seen.every((t) => typeof t === "number" && t > 0)).toBe(true);
	});

	it("runs the three probes concurrently, not one after another", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchFn = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 10));
			inFlight--;
			return bindings("p", "http://example.org/p1");
		};
		await probeSparqlEndpoint("https://e.test/sparql", fetchFn);
		// Sequentially this peaks at 1 and a slow probe adds its full wall clock.
		expect(peak).toBe(3);
	});

	it("falls back to a sampled predicate probe when the exhaustive scan fails", async () => {
		const queries: string[] = [];
		const fetchFn = async (q: string) => {
			queries.push(q);
			if (q.includes("SELECT DISTINCT ?p") && !q.includes("LIMIT 10000")) {
				throw new Error("timed out after 6000ms");
			}
			if (q.includes("LIMIT 10000")) return bindings("p", "http://example.org/sampled");
			return bindings("type", "http://example.org/C");
		};
		const out = await probeSparqlEndpoint("https://e.test/sparql", fetchFn);
		expect(out.predicates).toEqual(["http://example.org/sampled"]);
		// A sampled list is a weaker claim than a complete one — it must say so.
		expect(out.warnings.some((w) => /SAMPLE of the first 10000 triples/.test(w))).toBe(true);
		expect(out.warnings.some((w) => /Predicate probe failed/.test(w))).toBe(true);
	});

	it("does not use the sample when the exhaustive scan succeeds", async () => {
		const fetchFn = async (q: string) => {
			if (q.includes("LIMIT 10000")) throw new Error("sampled probe must not run");
			if (q.includes("SELECT DISTINCT ?p")) return bindings("p", "http://example.org/real");
			return bindings("type");
		};
		const out = await probeSparqlEndpoint("https://e.test/sparql", fetchFn);
		expect(out.predicates).toEqual(["http://example.org/real"]);
		expect(out.warnings.some((w) => /SAMPLE/.test(w))).toBe(false);
	});

	it("survives every probe failing, with warnings instead of a throw", async () => {
		const fetchFn = async () => {
			throw new Error("endpoint down");
		};
		const out = await probeSparqlEndpoint("https://e.test/sparql", fetchFn);
		expect(out.predicates).toEqual([]);
		expect(out.classes).toEqual([]);
		expect(out.graphs).toEqual([]);
		expect(out.warnings.length).toBeGreaterThanOrEqual(3);
	});
});
