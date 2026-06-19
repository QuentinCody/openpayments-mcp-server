/**
 * Canonical completeness signal — a machine-readable verdict on whether a
 * returned/staged result set is the COMPLETE answer to a query, or was cut
 * short (pagination not exhausted, a row/size cap applied, or rows dropped
 * during materialization).
 *
 * Motivation: scientific-data agents silently UNDER-COUNT records when
 * retrieval stops partway through pagination, and OVER-TRUST capped result
 * sets — both produce plausible-looking but wrong datasets (e.g. retrieving
 * 50 of 50,000 matching sequences and treating it as the whole). A single
 * explicit `complete: boolean` plus a machine-readable truncation reason lets
 * models (and humans) detect and recover from incompleteness instead of
 * treating a partial set as the full answer.
 *
 * Design bias: we err toward flagging POSSIBLE incompleteness. A false
 * "incomplete" is cheaply recoverable (the caller fetches more or re-checks);
 * a false "complete" is the dangerous, silent failure this module exists to
 * prevent. Cross-cutting primitive — imported by both staging/ and codemode/,
 * so it lives at the package root with no internal dependencies (no cycles).
 */

export type TruncationReason =
	/** Upstream is paginated and not all pages were fetched. */
	| "page_limit"
	/** An explicit LIMIT / retmax / top-N was applied to the result set. */
	| "row_limit"
	/** Response exceeded a byte cap. */
	| "size_limit"
	/** Some rows failed to materialize into SQLite during staging. */
	| "insertion_failure"
	/** The upstream API itself capped the result set. */
	| "upstream_cap"
	/** Incompleteness detected but the cause could not be classified. */
	| "unknown";

export interface Truncation {
	reason: TruncationReason;
	/** Human- and machine-readable explanation of what was cut short. */
	detail?: string;
	/** Actionable next step to retrieve the rest (e.g. "use api.getAll(...)"). */
	remedy?: string;
}

export interface Completeness {
	/** True iff the returned/staged set is the COMPLETE result for the query. */
	complete: boolean;
	/** Total records matching the query upstream, when known. */
	total_available?: number;
	/** Records actually returned / staged. */
	returned?: number;
	/** Present only when `complete === false`. */
	truncation?: Truncation;
}

/**
 * Coerce an unknown envelope value into a non-negative integer count.
 *
 * Handles the shapes upstream APIs actually use:
 * - numbers (`50000`)
 * - numeric strings (`"266"`) — **NCBI E-utilities return counts as strings**
 * - Elasticsearch `{ value, relation }` total objects
 */
export function asCount(v: unknown): number | undefined {
	if (typeof v === "number") {
		return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
	}
	if (typeof v === "string") {
		const trimmed = v.trim();
		if (/^\d+$/.test(trimmed)) {
			const n = Number(trimmed);
			return Number.isFinite(n) ? n : undefined;
		}
		return undefined;
	}
	// Elasticsearch-style `hits.total: { value: N, relation: "eq" | "gte" }`
	if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) {
		return asCount((v as Record<string, unknown>).value);
	}
	return undefined;
}

/**
 * Total-count field names in rough priority order. Explicit "total*" names win
 * over the ambiguous bare `count` (which some APIs use for page size). NCBI's
 * `esearchresult.count` is reached via the `count` key + nested containers.
 */
const TOTAL_KEYS: readonly string[] = [
	"total_count",
	"totalCount",
	"total_results",
	"totalResults",
	"total_records",
	"totalRecords",
	"record_count",
	"recordCount",
	"total_hits",
	"totalHits",
	"resultcount",
	"resultCount",
	"total",
	"numFound", // Solr
	"hitCount",
	"count", // lowest priority — ambiguous, may mean "this page"
];

/**
 * Containers to probe for a total-count field. `null` = the envelope root.
 * Covers the common nesting used by NCBI (`esearchresult`), Elasticsearch
 * (`hits`), and generic REST metadata blocks.
 */
const TOTAL_CONTAINERS: readonly (string | null)[] = [
	null,
	"meta",
	"metadata",
	"page_info",
	"pageInfo",
	"pagination",
	"paging",
	"page",
	"esearchresult",
	"hits",
	"header",
	"response", // Solr `{ response: { numFound } }`
];

/**
 * Best-effort extraction of the upstream "total matching records" count from a
 * response envelope. Returns `undefined` when no recognizable total is present.
 *
 * Scans key-major (highest-priority key across all containers first), so an
 * explicit `total_count` anywhere beats a bare `count`, and a root-level hit
 * beats a nested one for the same key.
 */
export function inferUpstreamTotal(envelope: unknown): number | undefined {
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		return undefined;
	}
	const root = envelope as Record<string, unknown>;
	for (const key of TOTAL_KEYS) {
		for (const container of TOTAL_CONTAINERS) {
			const scope = container == null ? root : root[container];
			if (scope && typeof scope === "object" && !Array.isArray(scope)) {
				const n = asCount((scope as Record<string, unknown>)[key]);
				if (n != null) return n;
			}
		}
	}
	return undefined;
}

/**
 * Build a completeness verdict by comparing a known upstream total against the
 * number of records actually retrieved. Returns `undefined` when either input
 * is unknown (can't make a claim either way).
 */
export function paginationCompleteness(
	upstreamTotal: number | undefined,
	returned: number | undefined,
): Completeness | undefined {
	if (upstreamTotal == null || returned == null) return undefined;
	if (upstreamTotal > returned) {
		return {
			complete: false,
			total_available: upstreamTotal,
			returned,
			truncation: {
				reason: "page_limit",
				detail: `Upstream reports ${upstreamTotal} matching record(s) but only ${returned} were retrieved.`,
				remedy:
					"Fetch the remaining records (use api.getAll(...) or paginate explicitly) before counting or downstream analysis — the current set is a partial sample.",
			},
		};
	}
	return { complete: true, total_available: upstreamTotal, returned };
}

/**
 * Build a completeness verdict for the staging materialization step from the
 * DO `/process` result. Incomplete iff rows were dropped during insertion.
 */
export function deriveMaterializationCompleteness(opts: {
	inputRows?: number;
	failedRows?: number;
	returned?: number;
	dataLossWarning?: string;
}): Completeness {
	const { inputRows, failedRows, returned, dataLossWarning } = opts;
	if (failedRows != null && failedRows > 0) {
		const detail =
			dataLossWarning ??
			`${failedRows}${inputRows != null ? ` of ${inputRows}` : ""} row(s) failed to materialize into SQLite.`;
		return {
			complete: false,
			...(returned != null ? { returned } : {}),
			truncation: {
				reason: "insertion_failure",
				detail,
				remedy:
					"Inspect staging_warnings.sample_errors (and the get_schema tool) — some records were dropped and are absent from query results.",
			},
		};
	}
	return { complete: true, ...(returned != null ? { returned } : {}) };
}

/**
 * Merge multiple completeness verdicts into one. Pass parts in priority order;
 * the result is `complete` only if every defined part is complete, and the
 * reported truncation is taken from the first incomplete part. Returns
 * `undefined` if no part is defined (no verdict to report).
 */
export function mergeCompleteness(
	...parts: (Completeness | undefined)[]
): Completeness | undefined {
	const defined = parts.filter((p): p is Completeness => p != null);
	if (defined.length === 0) return undefined;

	const complete = defined.every((p) => p.complete);
	const firstIncomplete = defined.find((p) => !p.complete);
	const total_available = defined.find((p) => p.total_available != null)?.total_available;
	const returned = defined.find((p) => p.returned != null)?.returned;

	return {
		complete,
		...(total_available != null ? { total_available } : {}),
		...(returned != null ? { returned } : {}),
		...(firstIncomplete?.truncation ? { truncation: firstIncomplete.truncation } : {}),
	};
}
