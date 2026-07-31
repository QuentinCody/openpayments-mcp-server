// Ranking for the "Valid fields: …" hint attached to an unknown-field error.
//
// The list has to be truncated — some CIViC types carry 40+ fields and the whole
// set would swamp the error. The question is WHICH ones survive the cut, and the
// original answer (the first N in declaration order) is the worst one: it is
// uncorrelated with what the caller asked for, so the field they actually wanted
// is hidden exactly when they need it.
//
// Observed live on bio.quentincody.dev (2026-07-31): a model asked for
// `clinicalSignificance` on `EvidenceItem`; the real field is `significance`, and
// it sat in the hidden `(+25 more)` tail. The model guessed again and burned a
// second call. Ranking by closeness to the rejected name puts the answer first
// within the same character budget.

/** Levenshtein edit distance, iterative single-row DP. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	const curr = new Array<number>(b.length + 1);

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const substitution = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, substitution);
		}
		prev = curr.slice();
	}
	return prev[b.length];
}

/**
 * Score tiers. Kept an order of magnitude apart so a containment match can never
 * be outranked by an edit-distance coincidence — the tier decides the ordering
 * and the within-tier bonus only breaks ties.
 */
const CASE_ONLY_MATCH = 3000;
const CONTAINMENT_MATCH = 2000;
const CONTAINMENT_OVERLAP_BONUS = 100;
const SIMILARITY_SCALE = 1000;

/**
 * How closely `candidate` answers a caller who asked for `rejected`. Higher is
 * closer.
 */
export function relevanceScore(pair: {
	candidate: string;
	rejected: string;
}): number {
	const c = pair.candidate.toLowerCase();
	const r = pair.rejected.toLowerCase();

	// Case-only difference: `clinicalsignificance` vs `clinicalSignificance`.
	// This also catches the two-empty-strings case, which is why the division
	// below can never see a zero divisor.
	if (c === r) return CASE_ONLY_MATCH;

	// One name contains the other — the common rename/prefix shape
	// (`clinicalSignificance` → `significance`, `geneId` → `id`). Longer overlap
	// relative to the pair wins, so `significance` beats `id` for a caller who
	// asked for `clinicalSignificance`.
	if (c.includes(r) || r.includes(c)) {
		const overlap = Math.min(c.length, r.length) / Math.max(c.length, r.length);
		return CONTAINMENT_MATCH + overlap * CONTAINMENT_OVERLAP_BONUS;
	}

	// Non-zero: equal-length-zero pairs returned above.
	const longest = Math.max(c.length, r.length);
	const similarity = 1 - editDistance(c, r) / longest;
	return similarity * SIMILARITY_SCALE;
}

/**
 * The `limit` field names most likely to be what the caller meant, closest
 * first. Ties break on the original order so output stays deterministic for a
 * given schema.
 */
export function rankFieldNames(
	names: readonly string[],
	rejected: string,
	limit: number,
): string[] {
	return names
		.map((name, index) => ({
			name,
			index,
			score: relevanceScore({ candidate: name, rejected }),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.name);
}

/**
 * Render the valid-field hint: closest matches first, and an explicit count of
 * what was withheld so the caller knows the list is partial rather than
 * assuming the schema is small.
 */
export function formatFieldSuggestions(
	names: readonly string[],
	rejected: string,
	limit: number,
): string {
	if (names.length <= limit) return names.join(", ");
	const ranked = rankFieldNames(names, rejected, limit);
	return `${ranked.join(", ")}, … (+${names.length - limit} more, closest listed first)`;
}
