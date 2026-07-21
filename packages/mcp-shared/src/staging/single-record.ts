/**
 * Single-record staging heuristic (T10.1).
 *
 * Staging is valuable for a LIST of many rows (query/aggregate via SQL). But a
 * SINGLE record (one UniProt entry, one gene) that merely happens to exceed the
 * 30KB threshold should NOT auto-stage — staging forces a needless
 * stage → get_schema → query round-trip just to read one field (the FOXP3 case:
 * a single UniProt entry auto-staged at `staged:4` on a 4-fact prompt). Instead,
 * a single record is returned inline up to near the 100KB structuredContent
 * transport limit.
 *
 * Detection is deliberately CONSERVATIVE: a response is treated as multi-row only
 * when a recognized collection key holds an array of >1 element (or the payload
 * itself is such an array). A single entity with large NESTED object-arrays
 * (UniProt `features`/`dbReferences`) is still a single record. Non-standard list
 * shapes fall back to the base threshold (no regression, just no improvement).
 */

/** Keys that, when holding an array of >1, mark a response as a list of entities. */
const COLLECTION_KEYS = [
	"results",
	"data",
	"items",
	"records",
	"hits",
	"entries",
	"rows",
	"docs",
	"nodes",
	"edges",
	"studies", // CT.gov /studies payload is { totalCount, studies:[...] } (#5)
];

/** Below this (and under the ~100KB transport limit), a single record stays inline. */
const SINGLE_RECORD_STAGE_THRESHOLD = 90 * 1024;
const DEFAULT_STAGING_THRESHOLD = 30 * 1024;

function hasMultiRowCollection(obj: Record<string, unknown>): boolean {
	for (const key of COLLECTION_KEYS) {
		const v = obj[key];
		if (Array.isArray(v) && v.length > 1) return true;
	}
	return false;
}

/** True when the response represents ONE entity rather than a list of many. */
export function isSingleRecordResponse(data: unknown): boolean {
	if (Array.isArray(data)) return data.length <= 1;
	if (!data || typeof data !== "object") return true;
	const obj = data as Record<string, unknown>;
	if (hasMultiRowCollection(obj)) return false;
	// GraphQL one-level nesting: { genes: { nodes: [...] } }, { search: { hits: [...] } }.
	for (const v of Object.values(obj)) {
		if (
			v &&
			typeof v === "object" &&
			!Array.isArray(v) &&
			hasMultiRowCollection(v as Record<string, unknown>)
		) {
			return false;
		}
	}
	return true;
}

/**
 * The effective auto-stage byte threshold for a response: raised for single
 * records (so they stay inline), the base for multi-row lists. `baseThreshold`
 * defaults to the shared 30KB when omitted.
 */
export function effectiveStagingThreshold(
	data: unknown,
	baseThreshold: number | undefined,
): number {
	const base = baseThreshold ?? DEFAULT_STAGING_THRESHOLD;
	return isSingleRecordResponse(data)
		? Math.max(base, SINGLE_RECORD_STAGE_THRESHOLD)
		: base;
}
