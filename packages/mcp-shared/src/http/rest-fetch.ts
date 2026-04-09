/**
 * REST HTTP fetch utility with retry, timeout, query string construction,
 * per-source rate limiting, and optional Worker-side caching.
 */

export interface RestFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | object;
	timeout?: number;
	retries?: number;
	retryOn?: number[];
	userAgent?: string;
	/** Rate-limit policy key — requests sharing the same key are serialized */
	rateLimitKey?: string;
	/** Cache options for Worker-side caching via Cloudflare Cache API */
	cache?: CacheOptions;
}

export interface CacheOptions {
	/** Time-to-live in seconds (default: 300 = 5 minutes) */
	ttl?: number;
	/** If true, bypass cache and fetch fresh (but still store result) */
	bypass?: boolean;
}

/** Per-source rate-limit policy */
export interface RateLimitPolicy {
	/** Unique key for this source (e.g. "opentargets", "pubmed") */
	key: string;
	/** Minimum interval between requests in milliseconds */
	minIntervalMs: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];
const DEFAULT_CACHE_TTL = 300;

// ── Per-source rate limiter ──────────────────────────────────────────────

const lastRequestTime = new Map<string, number>();

/**
 * Wait until the minimum interval has elapsed for a given rate-limit key.
 * Uses a simple timestamp map — sufficient for single-isolate Workers.
 */
async function waitForRateLimit(key: string, minIntervalMs: number): Promise<void> {
	const now = Date.now();
	const last = lastRequestTime.get(key) ?? 0;
	const elapsed = now - last;
	if (elapsed < minIntervalMs) {
		await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
	}
	lastRequestTime.set(key, Date.now());
}

// ── Registered policies (servers call registerRateLimitPolicy at startup) ─

const policies = new Map<string, RateLimitPolicy>();

/**
 * Register a rate-limit policy for a source key.
 * Call at server startup for each upstream API that needs throttling.
 */
export function registerRateLimitPolicy(policy: RateLimitPolicy): void {
	policies.set(policy.key, policy);
}

/**
 * Clear all registered rate-limit policies and timestamps. For testing only.
 */
export function resetRateLimitState(): void {
	policies.clear();
	lastRequestTime.clear();
}

// ── Worker-side cache helpers ────────────────────────────────────────────

function getWorkerCache(): Cache | undefined {
	if ("caches" in globalThis) {
		const store = (globalThis as { caches: { default?: Cache } }).caches;
		return store.default;
	}
	return undefined;
}

async function getCached(url: string): Promise<Response | undefined> {
	try {
		const cache = getWorkerCache();
		if (!cache) return undefined;
		const match = await cache.match(url);
		return match ?? undefined;
	} catch {
		return undefined;
	}
}

async function putCached(url: string, response: Response, ttl: number): Promise<void> {
	try {
		const cache = getWorkerCache();
		if (!cache) return;
		const clone = new Response(response.body, response);
		clone.headers.set("Cache-Control", `public, max-age=${ttl}`);
		await cache.put(url, clone);
	} catch {
		// Cache writes are best-effort
	}
}

/**
 * Build a query string from a params object. Handles arrays, undefined values.
 */
export function buildQueryString(params: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
			}
		} else {
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		}
	}
	return parts.join("&");
}

/**
 * Fetch a REST API with retries, timeout, query string construction,
 * optional per-source rate limiting, and Worker-side caching.
 */
export async function restFetch(
	baseUrl: string,
	path: string,
	params?: Record<string, unknown>,
	opts?: RestFetchOptions,
): Promise<Response> {
	const {
		method = "GET",
		headers = {},
		body,
		timeout = DEFAULT_TIMEOUT,
		retries = DEFAULT_RETRIES,
		retryOn = DEFAULT_RETRY_ON,
		userAgent = "bio-mcp-server/1.0",
		rateLimitKey,
		cache: cacheOpts,
	} = opts ?? {};

	let url = `${baseUrl.replace(/\/$/, "")}${path}`;
	if (params && Object.keys(params).length > 0) {
		const qs = buildQueryString(params);
		url += `?${qs}`;
	}

	// ── Cache lookup (GET-only, when cache options provided) ──────────
	const useCache = cacheOpts && method === "GET" && !cacheOpts.bypass;
	if (useCache) {
		const cached = await getCached(url);
		if (cached) return cached;
	}

	// ── Rate limiting ────────────────────────────────────────────────
	if (rateLimitKey) {
		const policy = policies.get(rateLimitKey);
		if (policy) {
			await waitForRateLimit(policy.key, policy.minIntervalMs);
		}
	}

	const fetchHeaders: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": userAgent,
		...headers,
	};

	const fetchInit: RequestInit = {
		method,
		headers: fetchHeaders,
		signal: AbortSignal.timeout(timeout),
	};

	if (body) {
		if (typeof body === "string") {
			fetchInit.body = body;
		} else {
			fetchInit.body = JSON.stringify(body);
			if (!fetchHeaders["Content-Type"]) {
				fetchHeaders["Content-Type"] = "application/json";
			}
		}
	}

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await fetch(url, fetchInit);

			if (retryOn.includes(response.status) && attempt < retries) {
				// Exponential backoff
				const delay = Math.min(1000 * 2 ** attempt, 10_000);
				// Parse Retry-After header if present
				const retryAfter = response.headers.get("Retry-After");
				const waitMs = retryAfter
					? Math.min(Number(retryAfter) * 1000 || delay, 30_000)
					: delay;
				await new Promise((r) => setTimeout(r, waitMs));
				continue;
			}

			// ── Cache store (only on 2xx GET responses) ──────────────
			if (useCache && response.ok) {
				const ttl = cacheOpts.ttl ?? DEFAULT_CACHE_TTL;
				await putCached(url, response.clone(), ttl);
			}

			return response;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = Math.min(1000 * 2 ** attempt, 10_000);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	throw lastError ?? new Error(`restFetch failed after ${retries + 1} attempts`);
}
