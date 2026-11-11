import { describe, expect, it } from "vitest";
import { rankBm25, tokenizeForBm25 } from "./bm25";

const PASSAGES = [
  { id: "a", text: "MET overexpression predicts sensitivity to rilotumumab in gastric cancer" },
  { id: "b", text: "The placebo group had longer overall survival than the rilotumumab group" },
  { id: "c", text: "Mice were housed in standard conditions with a 12 hour light cycle" },
  { id: "d", text: "" },
];

describe("tokenizeForBm25", () => {
  it("lowercases, splits on non-alphanumerics, and drops single characters", () => {
    expect(tokenizeForBm25("MET-positive (p<0.003); a B")).toEqual([
      "met",
      "positive",
      "003",
    ]);
  });
});

describe("rankBm25", () => {
  it("ranks the topically matching passage first", () => {
    const ranked = rankBm25(
      "rilotumumab overall survival placebo",
      PASSAGES,
      (p) => p.text,
    );
    expect(ranked[0].passage.id).toBe("b");
    expect(ranked.every((r) => r.score > 0)).toBe(true);
  });

  it("excludes zero-score passages and respects topK", () => {
    const ranked = rankBm25("rilotumumab", PASSAGES, (p) => p.text, { topK: 1 });
    expect(ranked).toHaveLength(1);
    const all = rankBm25("rilotumumab", PASSAGES, (p) => p.text);
    expect(all.map((r) => r.passage.id).sort()).toEqual(["a", "b"]);
  });

  it("returns empty for an empty query or empty corpus", () => {
    expect(rankBm25("", PASSAGES, (p) => p.text)).toEqual([]);
    expect(rankBm25("met", [], (p: { text: string }) => p.text)).toEqual([]);
  });

  it("rewards rare terms over common ones (idf)", () => {
    const corpus = [
      { text: "cancer cancer cancer treatment" },
      { text: "cancer vemurafenib treatment" },
      { text: "cancer treatment outcomes" },
    ];
    const ranked = rankBm25("vemurafenib cancer", corpus, (p) => p.text);
    expect(ranked[0].passage.text).toContain("vemurafenib");
  });

  it("keeps original indexes so callers can map back", () => {
    const ranked = rankBm25("light cycle", PASSAGES, (p) => p.text);
    expect(ranked[0].index).toBe(2);
  });
});
