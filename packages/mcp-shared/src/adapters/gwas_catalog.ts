/**
 * GWAS Catalog REST adapter.
 * Base: https://www.ebi.ac.uk/gwas/rest/api
 * Covers trait/association/study endpoints used to anchor L2G runs.
 */

const GWAS_BASE = "https://www.ebi.ac.uk/gwas/rest/api";

export interface GwasFetchOpts {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	userAgent?: string;
}

export async function gwasGet<T = unknown>(
	path: string,
	params: Record<string, unknown> = {},
	opts: GwasFetchOpts = {},
): Promise<T> {
	const {
		fetchImpl = fetch,
		timeoutMs = 30_000,
		userAgent = "bio-mcp-gwas/1.0",
	} = opts;
	const url = new URL(path.startsWith("http") ? path : `${GWAS_BASE}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v == null) continue;
		url.searchParams.set(k, String(v));
	}
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`GWAS Catalog HTTP ${resp.status}`);
		return (await resp.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/** Fetch v2 associations filtered by EFO trait or free-text term. */
export async function gwasAssociations(
	params: {
		efoId?: string;
		/** @deprecated Historical identifier argument; use efoId. */
		efoTrait?: string;
		traitName?: string;
		showChildTraits?: boolean;
		size?: number;
		page?: number;
	},
	opts: GwasFetchOpts = {},
): Promise<unknown> {
	const qp: Record<string, unknown> = {
		size: params.size ?? 200,
		page: params.page ?? 0,
	};
	// v2 separates ontology identifiers from labels and uses snake_case on the wire.
	// Contract: EBISPOT/gwas-mcp src/gwascatalog/mcp/data/rest-api-doc.yaml.
	const id = params.efoId ?? params.efoTrait;
	if (id) qp.efo_id = id;
	else if (params.traitName) qp.efo_trait = params.traitName;
	if (params.showChildTraits !== undefined) qp.show_child_trait = params.showChildTraits;
	return gwasGet("/v2/associations", qp, opts);
}
