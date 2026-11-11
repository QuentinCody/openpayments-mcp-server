import { registerRateLimitPolicy, restFetch } from "../../http/rest-fetch";
import { boundedText, eqtlError } from "./release";

/**
 * HTTP layer for the eQTL Catalogue.
 *
 * EBI retired the REST API (https://www.ebi.ac.uk/eqtl/api/v3/* answers 410
 * "This API is no longer available"). The catalogue now publishes the same data
 * as static bgzip/tabix flat files on the FTP tree, served over HTTPS with
 * `Accept-Ranges: bytes`, plus metadata tables in the resources repository.
 * Those two bases are what this server reads.
 *
 * EBI states on https://www.ebi.ac.uk/eqtl/Data_access/ that frequent
 * tabix-style requests are read as a denial-of-service attack and get the
 * source IP blacklisted until it is manually whitelisted. A Worker egresses
 * from shared Cloudflare addresses, so that would harm the whole fleet, not
 * just this server. Every FTP request therefore goes through one rate-limit
 * key, and index/header/metadata reads are cached so the steady-state cost of
 * a region query is a single range GET.
 */

export const EBI_FTP_BASE = "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL";
export const CATALOGUE_RESOURCES_BASE =
	"https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master";

const EBI_FTP_RATE_LIMIT_KEY = "eqtl-ebi-ftp";
const USER_AGENT = "eqtl-catalogue-mcp-server/2.0 (bio-mcp; +https://bio.quentincody.dev)";

/** EBI's own guidance is "one request in every couple of seconds". */
registerRateLimitPolicy({ key: EBI_FTP_RATE_LIMIT_KEY, minIntervalMs: 2000 });

export interface ByteRange {
	start: number;
	/** Inclusive end. Omit for "to end of file". */
	end?: number;
}

export interface EqtlFileFetchOptions {
	range?: ByteRange;
	/** Per-attempt cap, ms. */
	timeout?: number;
	/** Wall-clock cap across attempts, ms. */
	deadlineMs?: number;
	/** Cache TTL in seconds. Ignored for range reads — the Cache API keys on the
	 *  URL alone, so storing a 206 there would poison the full-file entry. */
	cacheTtlSeconds?: number;
}

/** The metadata tables list `ftp://` URLs; the same paths serve over HTTPS. */
export function toHttpsUrl(url: string): string {
	return url.replace(/^ftp:\/\//i, "https://");
}

function splitUrl(url: string): { base: string; path: string } {
	const parsed = new URL(url);
	return { base: parsed.origin, path: `${parsed.pathname}${parsed.search}` };
}

async function assertOk(response: Response, url: string): Promise<Response> {
	if (response.ok) return response;
	const body = await boundedText(response);
	eqtlError(`HTTP ${response.status} for ${url}`, response.status, {
		source_url: url, http_status: response.status, response: body,
		content_type: response.headers.get("content-type"),
	});
}

/**
 * Fetch a file from the EBI eQTL FTP tree over HTTPS, rate-limited and
 * optionally range-limited. Throws on any non-2xx status — a 404 here means the
 * dataset genuinely does not publish that file, and callers must say so rather
 * than report an empty result.
 */
export async function ebiFileFetch(url: string, opts?: EqtlFileFetchOptions): Promise<Response> {
	const httpsUrl = toHttpsUrl(url);
	const { base, path } = splitUrl(httpsUrl);
	const headers: Record<string, string> = { Accept: "*/*" };
	if (opts?.range) {
		const { start, end } = opts.range;
		headers.Range = `bytes=${start}-${end === undefined ? "" : end}`;
	}

	const response = await restFetch(base, path, undefined, {
		headers,
		retryOn: [429, 500, 502, 503, 504],
		retries: 2,
		timeout: opts?.timeout ?? 20_000,
		deadlineMs: opts?.deadlineMs ?? 45_000,
		userAgent: USER_AGENT,
		rateLimitKey: EBI_FTP_RATE_LIMIT_KEY,
		cache: opts?.cacheTtlSeconds && !opts.range ? { ttl: opts.cacheTtlSeconds } : undefined,
	});

	return assertOk(response, httpsUrl);
}

/** Fetch a metadata table from the eQTL-Catalogue-resources repository. */
export async function resourcesFetch(
	path: string,
	opts?: { cacheTtlSeconds?: number },
): Promise<Response> {
	const url = `${CATALOGUE_RESOURCES_BASE}${path}`;
	const response = await restFetch(CATALOGUE_RESOURCES_BASE, path, undefined, {
		headers: { Accept: "text/plain" },
		retryOn: [429, 500, 502, 503, 504],
		retries: 2,
		timeout: 20_000,
		deadlineMs: 45_000,
		userAgent: USER_AGENT,
		cache: { ttl: opts?.cacheTtlSeconds ?? 21_600 },
	});

	return assertOk(response, url);
}
