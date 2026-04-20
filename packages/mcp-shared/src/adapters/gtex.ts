/**
 * GTEx Portal v2 REST adapter.
 * Base: https://gtexportal.org/api/v2
 * Used endpoints: /association/singleTissueEqtl, /variant/variantById
 */

const GTEX_BASE = "https://gtexportal.org/api/v2";

export interface GtexFetchOpts {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	userAgent?: string;
}

export async function gtexGet<T = unknown>(
	path: string,
	params: Record<string, unknown> = {},
	opts: GtexFetchOpts = {},
): Promise<T> {
	const { fetchImpl = fetch, timeoutMs = 15_000, userAgent = "bio-mcp-gtex/1.0" } = opts;
	const url = new URL(path.startsWith("http") ? path : `${GTEX_BASE}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v == null) continue;
		if (Array.isArray(v)) {
			for (const item of v) url.searchParams.append(k, String(item));
		} else {
			url.searchParams.set(k, String(v));
		}
	}
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url.toString(), {
			headers: { Accept: "application/json", "User-Agent": userAgent },
			signal: ctrl.signal,
		});
		if (!resp.ok) throw new Error(`GTEx HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
		return (await resp.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetch single-tissue eQTLs for a batch of variant IDs.
 * `variantIds` may be comma-separated or passed as an array — GTEx accepts multiple values.
 */
export async function gtexEqtlsByVariants(
	variantIds: string[],
	opts: GtexFetchOpts & { tissueSiteDetailId?: string | string[]; itemsPerPage?: number } = {},
): Promise<unknown> {
	const params: Record<string, unknown> = {
		variantId: variantIds,
		itemsPerPage: opts.itemsPerPage ?? 250,
	};
	if (opts.tissueSiteDetailId) params.tissueSiteDetailId = opts.tissueSiteDetailId;
	return gtexGet("/association/singleTissueEqtl", params, opts);
}
