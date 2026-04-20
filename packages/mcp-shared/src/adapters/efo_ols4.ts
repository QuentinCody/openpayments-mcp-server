/**
 * EBI OLS4 ontology REST adapter (primarily EFO).
 * Base: https://www.ebi.ac.uk/ols4/api
 */

const OLS4_BASE = "https://www.ebi.ac.uk/ols4/api";

export interface Ols4FetchOpts {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	userAgent?: string;
}

export async function ols4Search(
	query: string,
	opts: Ols4FetchOpts & { ontology?: string; rows?: number; exact?: boolean } = {},
): Promise<unknown> {
	const {
		fetchImpl = fetch,
		timeoutMs = 15_000,
		userAgent = "bio-mcp-ols4/1.0",
		ontology = "efo",
		rows = 25,
		exact = false,
	} = opts;
	const url = new URL(`${OLS4_BASE}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("ontology", ontology);
	url.searchParams.set("type", "class");
	url.searchParams.set("queryFields", "label,synonym,short_form,obo_id");
	url.searchParams.set("rows", String(rows));
	url.searchParams.set("exact", exact ? "true" : "false");
	url.searchParams.set("local", "true");
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`OLS4 HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}

export async function ols4TermDescendants(
	ontology: string,
	iri: string,
	opts: Ols4FetchOpts & { size?: number; page?: number } = {},
): Promise<unknown> {
	const { fetchImpl = fetch, timeoutMs = 15_000, userAgent = "bio-mcp-ols4/1.0", size = 200, page = 0 } = opts;
	const encoded = encodeURIComponent(encodeURIComponent(iri));
	const url = new URL(`${OLS4_BASE}/ontologies/${ontology}/terms/${encoded}/descendants`);
	url.searchParams.set("size", String(size));
	url.searchParams.set("page", String(page));
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`OLS4 HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}
