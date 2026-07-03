/**
 * OpenPayments API adapter — wraps openpaymentsFetch into the ApiFetchFn
 * interface for use by the Code Mode __api_proxy tool.
 */

import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import {
    EmptyDatasetError,
    guardEmptyResult,
} from "@bio-mcp/shared/codemode/empty-result-guard";
import { openpaymentsFetch } from "./http";

/** Parse one DKAN response into `{ status, data }` (throws on !ok). */
async function fetchParsed(
    path: string,
    params?: Record<string, unknown>,
    opts?: { timeout?: number; retries?: number },
): Promise<{ status: number; data: unknown }> {
    const response = await openpaymentsFetch(path, params, opts);

    if (!response.ok) {
        let errorBody: string;
        try {
            errorBody = await response.text();
        } catch {
            errorBody = response.statusText;
        }
        const error = new Error(
            `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        ) as Error & {
            status: number;
            data: unknown;
        };
        error.status = response.status;
        error.data = errorBody;
        throw error;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
        const text = await response.text();
        return { status: response.status, data: text };
    }

    const data = await response.json();
    return { status: response.status, data };
}

/** A filtered DKAN datastore query — the only shape whose empty we verify. */
function isFilteredDatastoreQuery(request: {
    path: string;
    params?: Record<string, unknown>;
}): boolean {
    if (!request.path.includes("/datastore/query/")) return false;
    const conditions = request.params?.conditions;
    return Array.isArray(conditions) && conditions.length > 0;
}

/** True when a DKAN datastore payload carries zero result rows. */
function isEmptyDkan(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const d = data as { results?: unknown; count?: unknown };
    if (Array.isArray(d.results)) return d.results.length === 0;
    if (typeof d.count === "number") return d.count === 0;
    return false;
}

/**
 * Verify a filtered datastore query that came back empty before trusting it as
 * absence (a "this provider has no payments" answer). Probe-only (no retry):
 * probes the SAME dataset unfiltered (limit 1) with a tight, retry-free budget,
 * certifies a live-but-empty filter, throws when the dataset itself looks
 * empty/unreachable, and degrades gracefully if the probe can't complete. On a
 * certified empty the DKAN envelope object gets a `__guard` annotation inline.
 */
async function verifyEmpty(
    first: { status: number; data: unknown },
    path: string,
    describe: string,
): Promise<{ status: number; data: unknown }> {
    const probeParams = { limit: 1, keys: true, schema: false, count: true };
    const outcome = await guardEmptyResult(first.data, {
        isEmpty: isEmptyDkan,
        probe: async () =>
            (await fetchParsed(path, probeParams, { timeout: 6000, retries: 0 }))
                .data,
        describe,
        log: (m) => console.warn(`[empty-guard] ${m}`),
    });
    const data =
        outcome.guard && outcome.data && typeof outcome.data === "object"
            ? { ...(outcome.data as Record<string, unknown>), __guard: outcome.guard }
            : outcome.data;
    return { status: first.status, data };
}

/**
 * Create an ApiFetchFn that routes through openpaymentsFetch.
 * No auth needed — OpenPayments DKAN API is public.
 */
export function createOpenPaymentsApiFetch(): ApiFetchFn {
    return async (request) => {
        const result = await fetchParsed(request.path, request.params);

        // Guard against silent transient empties on FILTERED datastore queries —
        // a real provider returning 0 rows during a CDN blip or dataset-UUID churn
        // reads as "no payments" when it should not. Unfiltered/browse queries with
        // legitimately-empty results are left alone.
        if (isFilteredDatastoreQuery(request) && isEmptyDkan(result.data)) {
            return await verifyEmpty(result, request.path, `OpenPayments ${request.path}`);
        }

        return result;
    };
}

export { EmptyDatasetError };
