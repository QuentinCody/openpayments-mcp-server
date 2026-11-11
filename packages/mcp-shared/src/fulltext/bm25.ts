/**
 * Okapi BM25 passage ranking. Pure computation, no dependencies — runs in a
 * Worker, a V8 isolate preamble, or Node. Intended for ranking staged
 * full-text chunks against a claim/query without any model call.
 */

export interface RankedPassage<T> {
  passage: T;
  index: number;
  score: number;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  /** Return at most this many passages (default: all with score > 0). */
  topK?: number;
}

export function tokenizeForBm25(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Rank passages by BM25 relevance to a query. `getText` extracts the text
 * from each passage object so callers can rank rich objects directly.
 */
export function rankBm25<T>(
  query: string,
  passages: readonly T[],
  getText: (p: T) => string,
  opts: Bm25Options = {},
): RankedPassage<T>[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const queryTerms = [...new Set(tokenizeForBm25(query))];
  if (queryTerms.length === 0 || passages.length === 0) return [];

  const docs = passages.map((p) => tokenizeForBm25(getText(p)));
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

  // Document frequency per query term.
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let n = 0;
    for (const d of docs) if (d.includes(term)) n++;
    df.set(term, n);
  }

  const n = docs.length;
  const scored: RankedPassage<T>[] = passages.map((passage, index) => {
    const doc = docs[index];
    if (doc.length === 0) return { passage, index, score: 0 };
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const dfi = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLen));
    }
    return { passage, index, score };
  });

  const ranked = scored.filter((s) => s.score > 0).sort((a, z) => z.score - a.score);
  return opts.topK !== undefined ? ranked.slice(0, opts.topK) : ranked;
}
