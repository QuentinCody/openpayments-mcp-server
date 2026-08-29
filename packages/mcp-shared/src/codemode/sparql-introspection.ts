/**
 * SPARQL "introspection" — best-effort discovery of an endpoint's shape via
 * VOID descriptions + sample-query fallback. The result is injected into the
 * V8 isolate as a compact JSON object (analog to GraphQL introspection).
 *
 * Trims to ~5KB to keep isolate prompts cheap.
 */

export type SparqlFetchFn = (
	query: string,
	opts?: { method?: "GET" | "POST"; format?: string; timeoutMs?: number },
) => Promise<unknown>;

export interface SparqlEndpointDescription {
	endpointUrl: string;
	/** Named graphs (from VOID, falls back to empty when discovery fails). */
	graphs: string[];
	/** Up to 30 distinct predicates seen on a small probe. */
	predicates: string[];
	/** Up to 30 distinct rdf:type values seen. */
	classes: string[];
	/** Discovery warnings (non-fatal). */
	warnings: string[];
}

const PROBE_PREDICATES = `
SELECT DISTINCT ?p WHERE { ?s ?p ?o } LIMIT 30
`;

/**
 * Fallback for stores where the exhaustive form is pathological.
 *
 * `SELECT DISTINCT ?p WHERE { ?s ?p ?o } LIMIT 30` cannot stop at 30: DISTINCT
 * has to scan the whole store before it knows the distinct set, so the LIMIT
 * prunes the OUTPUT, not the WORK. Measured against Bgee 2026-08-28 that is
 * 28.98s, against 0.34s for the class probe and 0.36s for a real user query on
 * the same endpoint — i.e. discovery cost ~80x the query it was there to help.
 *
 * Sampling a bounded slice first makes the work proportional to the slice. It is
 * strictly less representative — on Bgee the first 10k triples happen to share a
 * single predicate — so this is a FALLBACK, never the default, and callers are
 * told via `warnings` when it was used.
 */
const PROBE_PREDICATES_SAMPLED = `
SELECT DISTINCT ?p WHERE { { SELECT ?p WHERE { ?s ?p ?o } LIMIT 10000 } } LIMIT 30
`;

/**
 * Per-probe wall-clock budget. Discovery is best-effort metadata that makes the
 * isolate prompt nicer; it must never dominate the isolate's own 30s budget the
 * way it did on Bgee, where a green sweep sat ~160ms from timing out.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 6_000;

const PROBE_CLASSES = `
SELECT DISTINCT ?type WHERE { ?s a ?type } LIMIT 30
`;

const VOID_GRAPHS = `
PREFIX void: <http://rdfs.org/ns/void#>
SELECT DISTINCT ?g WHERE { ?ds void:sparqlEndpoint ?ep . ?ds void:subset ?g } LIMIT 30
`;

interface SparqlBinding {
	[variable: string]: { type?: string; value?: string };
}

interface SparqlResults {
	head?: { vars?: string[] };
	results?: { bindings?: SparqlBinding[] };
}

function bindingsValues(raw: unknown, variable: string): string[] {
	const r = raw as SparqlResults;
	const bindings = r?.results?.bindings ?? [];
	const out: string[] = [];
	for (const b of bindings) {
		const v = b?.[variable]?.value;
		if (typeof v === "string") out.push(v);
	}
	return out;
}

export async function probeSparqlEndpoint(
	endpointUrl: string,
	sparqlFetch: SparqlFetchFn,
	opts?: { perProbeTimeoutMs?: number },
): Promise<SparqlEndpointDescription> {
	const timeoutMs = opts?.perProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const warnings: string[] = [];

	// Concurrent, not sequential: the three probes are independent, so a slow one
	// used to add its whole wall clock to the other two.
	const [graphsRes, predicatesRes, classesRes] = await Promise.all([
		runProbe(sparqlFetch, VOID_GRAPHS, "g", timeoutMs),
		runProbe(sparqlFetch, PROBE_PREDICATES, "p", timeoutMs),
		runProbe(sparqlFetch, PROBE_CLASSES, "type", timeoutMs),
	]);

	const graphs = collect(graphsRes, warnings, "VOID graph discovery");
	const classes = collect(classesRes, warnings, "Class probe");
	let predicates = collect(predicatesRes, warnings, "Predicate probe");

	// The exhaustive predicate scan is the one that goes pathological. If it did,
	// take a bounded sample rather than returning nothing — and say so, because a
	// sampled predicate list is a weaker claim than a complete one.
	if (!predicates.length && predicatesRes.error) {
		const sampled = await runProbe(sparqlFetch, PROBE_PREDICATES_SAMPLED, "p", timeoutMs);
		predicates = collect(sampled, warnings, "Sampled predicate probe");
		if (predicates.length) {
			warnings.push(
				"Predicates are a SAMPLE of the first 10000 triples, not the endpoint's full predicate set — the exhaustive DISTINCT scan exceeded the discovery budget.",
			);
		}
	}

	return { endpointUrl, graphs, predicates, classes, warnings };
}

interface ProbeOutcome {
	values: string[];
	error?: string;
}

async function runProbe(
	sparqlFetch: SparqlFetchFn,
	query: string,
	variable: string,
	timeoutMs: number,
): Promise<ProbeOutcome> {
	try {
		const raw = await sparqlFetch(query, { format: "json", timeoutMs });
		return { values: bindingsValues(raw, variable) };
	} catch (err) {
		return { values: [], error: (err as Error).message };
	}
}

function collect(outcome: ProbeOutcome, warnings: string[], label: string): string[] {
	if (outcome.error) warnings.push(`${label} failed: ${outcome.error}`);
	return outcome.values;
}

/** Common ontology prefixes used across life-science SPARQL endpoints. */
export const COMMON_PREFIXES: Record<string, string> = {
	rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
	rdfs: "http://www.w3.org/2000/01/rdf-schema#",
	owl: "http://www.w3.org/2002/07/owl#",
	xsd: "http://www.w3.org/2001/XMLSchema#",
	skos: "http://www.w3.org/2004/02/skos/core#",
	dcterms: "http://purl.org/dc/terms/",
	void: "http://rdfs.org/ns/void#",
	obo: "http://purl.obolibrary.org/obo/",
	uberon: "http://purl.obolibrary.org/obo/UBERON_",
	go: "http://purl.obolibrary.org/obo/GO_",
	ncbigene: "http://identifiers.org/ncbigene/",
	efo: "http://www.ebi.ac.uk/efo/EFO_",
	obi: "http://purl.obolibrary.org/obo/OBI_",
	sio: "http://semanticscience.org/resource/",
	up: "http://purl.uniprot.org/core/",
	ensembl: "http://identifiers.org/ensembl/",
	bgee: "http://bgee.org/#",
};

export function buildPrefixHeader(prefixes: Record<string, string>): string {
	return Object.entries(prefixes)
		.map(([k, v]) => `PREFIX ${k}: <${v}>`)
		.join("\n");
}
