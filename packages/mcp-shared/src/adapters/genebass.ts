/**
 * Genebass REST adapter.
 * Base: https://main.genebass.org/api (provider web client).
 * Gene burden PheWAS by Ensembl gene ID.
 */

const GENEBASS_BASE = "https://main.genebass.org/api";

export interface GenebassFetchOpts {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	userAgent?: string;
}

export async function genebassGeneBurden(
	ensemblGeneId: string,
	burdenSet: string = "pLoF",
	opts: GenebassFetchOpts & { params?: Record<string, unknown> } = {},
): Promise<unknown> {
	const {
		fetchImpl = fetch,
		timeoutMs = 20_000,
		userAgent = "bio-mcp-genebass/1.0",
		params = {},
	} = opts;
	if (!/^ENSG\d+$/.test(ensemblGeneId)) throw new Error("Genebass requires an unversioned Ensembl gene ID");
	const url = new URL(`${GENEBASS_BASE}/phewas/${ensemblGeneId}`);
	for (const [k, v] of Object.entries(params)) {
		if (v == null) continue;
		url.searchParams.set(k, String(v));
	}
	url.searchParams.set("burdenSet", burdenSet);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) {
			throw new Error(
				`Genebass HTTP ${resp.status}: ${await resp.text().catch(() => "")}`,
			);
		}
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}
