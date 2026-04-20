/**
 * Human Protein Atlas REST adapter.
 * Base: https://www.proteinatlas.org
 * Single-gene detail via /{ensembl_id}.json, search via /api/search_download.php.
 */

const HPA_BASE = "https://www.proteinatlas.org";

export interface HpaFetchOpts {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	userAgent?: string;
}

export async function hpaGene(
	ensemblId: string,
	opts: HpaFetchOpts = {},
): Promise<unknown> {
	const { fetchImpl = fetch, timeoutMs = 15_000, userAgent = "bio-mcp-hpa/1.0" } = opts;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(`${HPA_BASE}/${encodeURIComponent(ensemblId)}.json`, {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`HPA HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}

export async function hpaSearch(
	query: string,
	opts: HpaFetchOpts & { columns?: string } = {},
): Promise<unknown> {
	const { fetchImpl = fetch, timeoutMs = 15_000, userAgent = "bio-mcp-hpa/1.0", columns } = opts;
	const url = new URL(`${HPA_BASE}/api/search_download.php`);
	url.searchParams.set("search", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("compress", "no");
	if (columns) url.searchParams.set("columns", columns);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`HPA HTTP ${resp.status}`);
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}
