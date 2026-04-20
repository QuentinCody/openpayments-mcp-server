/**
 * ClinVar (NCBI eutils) adapter.
 * Uses efetch/esummary against the ClinVar database.
 */

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export interface ClinvarFetchOpts {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	userAgent?: string;
	apiKey?: string;
}

/** esummary returns JSON docsums for ClinVar variation IDs (VCV internal ids). */
export async function clinvarEsummary(
	ids: string[],
	opts: ClinvarFetchOpts = {},
): Promise<unknown> {
	const { fetchImpl = fetch, timeoutMs = 15_000, userAgent = "bio-mcp-clinvar/1.0", apiKey } = opts;
	const url = new URL(`${EUTILS_BASE}/esummary.fcgi`);
	url.searchParams.set("db", "clinvar");
	url.searchParams.set("id", ids.join(","));
	url.searchParams.set("retmode", "json");
	if (apiKey) url.searchParams.set("api_key", apiKey);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`ClinVar HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}

/** Search ClinVar by rsID — returns esearch results; caller feeds IDs to esummary. */
export async function clinvarEsearchByRsid(
	rsid: string,
	opts: ClinvarFetchOpts = {},
): Promise<unknown> {
	const { fetchImpl = fetch, timeoutMs = 15_000, userAgent = "bio-mcp-clinvar/1.0", apiKey } = opts;
	const url = new URL(`${EUTILS_BASE}/esearch.fcgi`);
	url.searchParams.set("db", "clinvar");
	url.searchParams.set("term", `${rsid}[Variant ID]`);
	url.searchParams.set("retmode", "json");
	if (apiKey) url.searchParams.set("api_key", apiKey);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`ClinVar HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}
