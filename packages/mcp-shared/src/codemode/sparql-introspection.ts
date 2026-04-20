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
): Promise<SparqlEndpointDescription> {
	const warnings: string[] = [];
	let graphs: string[] = [];
	let predicates: string[] = [];
	let classes: string[] = [];

	try {
		const raw = await sparqlFetch(VOID_GRAPHS, { format: "json" });
		graphs = bindingsValues(raw, "g");
	} catch (err) {
		warnings.push(`VOID graph discovery failed: ${(err as Error).message}`);
	}

	try {
		const raw = await sparqlFetch(PROBE_PREDICATES, { format: "json" });
		predicates = bindingsValues(raw, "p");
	} catch (err) {
		warnings.push(`Predicate probe failed: ${(err as Error).message}`);
	}

	try {
		const raw = await sparqlFetch(PROBE_CLASSES, { format: "json" });
		classes = bindingsValues(raw, "type");
	} catch (err) {
		warnings.push(`Class probe failed: ${(err as Error).message}`);
	}

	return { endpointUrl, graphs, predicates, classes, warnings };
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
